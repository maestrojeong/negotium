/**
 * Byte-accurate bounded output buffer with lossless spill, for background bash.
 *
 * Replaces the previous `appendBounded` string concatenation, which had three
 * defects:
 *
 *   1. `MAX_OUTPUT_BYTES` was compared against `String.length` (UTF-16 code
 *      units), so a 200 KB cap admitted ~600 KB of Korean/CJK output.
 *   2. The truncation marker pushed the buffer permanently past the cap, so
 *      every subsequent chunk re-sliced the whole 200 KB string.
 *   3. `slice()` cut at arbitrary code-unit offsets, splitting surrogate pairs
 *      into replacement characters. Decoding each `Buffer` chunk independently
 *      split multi-byte UTF-8 sequences across chunk boundaries for the same
 *      reason.
 *
 * This buffer keeps raw bytes in a head window plus an amortized tail window,
 * decodes only at read time (correcting UTF-8 boundaries), and mirrors every
 * raw chunk to a spill file so the complete output stays recoverable.
 *
 * Design borrowed from `maestro-agent-sdk`'s `tool-result-truncation` (bounded
 * preview + explicit metadata + recoverable reference) and Gajae Code's
 * `session/streaming-output.ts` (`TailBuffer`'s amortized trim, byte-accurate
 * head/tail truncation). Unlike the SDK, the reference here is a plain
 * filesystem path rather than an opaque URI: the caller of `background_bash`
 * already has arbitrary shell access, so an opaque handle would add ceremony
 * without adding containment, and a real path lets the agent `grep`/`tail` the
 * spill directly.
 */
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Longest valid UTF-8 sequence, in bytes. */
const MAX_UTF8_SEQUENCE = 4;

export interface BoundedOutputOptions {
  /** Total preview budget in bytes, split between the head and tail windows. */
  maxBytes: number;
  /** When set, every raw chunk is mirrored here so nothing is lost. */
  spillPath?: string;
}

export interface OutputSnapshot {
  /** Bounded, UTF-8-safe preview text. */
  text: string;
  /** Every byte ever written to this stream. */
  totalBytes: number;
  /** Bytes dropped from the middle of the preview. */
  omittedBytes: number;
  /** Whether anything was dropped from the preview. */
  truncated: boolean;
  /** Absolute path of the complete output, when a spill is active and healthy. */
  spillPath?: string;
  /** Why the spill is unusable. Set means the omitted bytes are unrecoverable. */
  spillError?: string;
}

export interface IncrementalRead {
  /** New text since the supplied cursor. */
  text: string;
  /** Cursor to pass to the next call. */
  nextCursor: number;
  /** Bytes that aged out of the retained window before this read reached them. */
  droppedBytes: number;
}

/**
 * Byte offset at which `buf` can be cut without splitting a UTF-8 sequence.
 *
 * Scans back for the sequence's lead byte and drops the sequence when it is
 * still incomplete, so the tail of a head window never decodes to U+FFFD.
 */
export function utf8SafeEnd(buf: Uint8Array): number {
  const end = buf.length;
  for (let back = 1; back <= MAX_UTF8_SEQUENCE && back <= end; back++) {
    const byte = buf[end - back] as number;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte — keep scanning back
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? end - back : end;
  }
  return end;
}

/**
 * Byte offset at which `buf` starts a UTF-8 sequence.
 *
 * Skips orphaned continuation bytes left when a window opens mid-character.
 */
export function utf8SafeStart(buf: Uint8Array): number {
  let start = 0;
  while (start < buf.length && ((buf[start] as number) & 0xc0) === 0x80) start++;
  return start;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Decode a window, trimming both ends to UTF-8 sequence boundaries. */
function decodeWindow(buf: Buffer): string {
  const start = utf8SafeStart(buf);
  const end = Math.max(start, utf8SafeEnd(buf));
  return buf.subarray(start, end).toString("utf-8");
}

export class BoundedOutputStream {
  readonly #headBudget: number;
  readonly #tailBudget: number;
  readonly #spillPath?: string;

  #head: Buffer[] = [];
  #headBytes = 0;
  #tail: Buffer[] = [];
  #tailBytes = 0;
  #totalBytes = 0;

  #spillFd?: number;
  #spillError?: string;
  #closed = false;

  constructor(options: BoundedOutputOptions) {
    const maxBytes = Math.max(1024, Math.floor(options.maxBytes));
    this.#headBudget = Math.floor(maxBytes / 2);
    this.#tailBudget = maxBytes - this.#headBudget;
    this.#spillPath = options.spillPath;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  /** Absolute spill path, or undefined when spilling is off or has failed. */
  get spillPath(): string | undefined {
    return this.#spillError ? undefined : this.#spillPath;
  }

  get spillError(): string | undefined {
    return this.#spillError;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#spill(chunk);
    this.#totalBytes += chunk.length;

    let rest = chunk;
    if (this.#headBytes < this.#headBudget) {
      const room = this.#headBudget - this.#headBytes;
      const take = Math.min(room, rest.length);
      // Copy: the source Buffer may be pooled and reused by the stream, and a
      // subarray would pin the whole pooled allocation alive.
      this.#head.push(Buffer.from(rest.subarray(0, take)));
      this.#headBytes += take;
      rest = rest.subarray(take);
      if (rest.length === 0) return;
    }

    this.#tail.push(Buffer.from(rest));
    this.#tailBytes += rest.length;
    // Trim at 2x budget so the cost is amortized instead of per-chunk.
    if (this.#tailBytes > this.#tailBudget * 2) this.#trimTail();
  }

  /** Bounded preview plus the metadata needed to describe what was dropped. */
  snapshot(): OutputSnapshot {
    this.#trimTail();
    const head = Buffer.concat(this.#head);
    const tail = Buffer.concat(this.#tail);
    const omittedBytes = Math.max(0, this.#totalBytes - head.length - tail.length);

    // Nothing dropped: the two windows are contiguous, so decode them as one
    // buffer. Decoding separately would split a character straddling the seam.
    if (omittedBytes === 0) {
      return {
        text: Buffer.concat([head, tail]).toString("utf-8"),
        totalBytes: this.#totalBytes,
        omittedBytes: 0,
        truncated: false,
        ...(this.spillPath ? { spillPath: this.spillPath } : {}),
        ...(this.#spillError ? { spillError: this.#spillError } : {}),
      };
    }

    const notice = `\n…[${formatBytes(omittedBytes)} omitted]…\n`;
    return {
      text: decodeWindow(head) + notice + decodeWindow(tail),
      totalBytes: this.#totalBytes,
      omittedBytes,
      truncated: true,
      ...(this.spillPath ? { spillPath: this.spillPath } : {}),
      ...(this.#spillError ? { spillError: this.#spillError } : {}),
    };
  }

  /**
   * Read what arrived after `cursor`.
   *
   * `nextCursor` never advances past a partial trailing sequence, so a
   * character split across two polls is delivered whole on the second one.
   * When the requested offset already aged out of the retained window the gap
   * is reported in `droppedBytes` instead of being silently skipped.
   */
  readSince(cursor: number): IncrementalRead {
    this.#trimTail();
    const clamped = Math.max(0, Math.min(cursor, this.#totalBytes));
    if (clamped >= this.#totalBytes) {
      return { text: "", nextCursor: this.#totalBytes, droppedBytes: 0 };
    }

    const head = Buffer.concat(this.#head);
    const tail = Buffer.concat(this.#tail);
    const retained = head.length + tail.length;

    let window: Buffer;
    let windowStart: number;
    let droppedBytes: number;
    if (retained >= this.#totalBytes) {
      // No gap yet — the retained bytes are the whole stream.
      window = Buffer.concat([head, tail]);
      windowStart = 0;
      droppedBytes = 0;
    } else {
      // Serve from the tail; anything between the cursor and the tail is gone.
      window = tail;
      windowStart = this.#totalBytes - tail.length;
      droppedBytes = Math.max(0, windowStart - clamped);
    }

    const from = Math.max(clamped, windowStart) - windowStart;
    const slice = window.subarray(from);
    const start = utf8SafeStart(slice);
    const end = Math.max(start, utf8SafeEnd(slice));
    const body = slice.subarray(start, end);
    return {
      text: body.toString("utf-8"),
      nextCursor: windowStart + from + start + body.length,
      droppedBytes: droppedBytes + start,
    };
  }

  /** Flush and release the spill descriptor. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#spillFd === undefined) return;
    try {
      closeSync(this.#spillFd);
    } catch {
      // Nothing actionable at close time; the spill contents already landed.
    }
    this.#spillFd = undefined;
  }

  #trimTail(): void {
    let excess = this.#tailBytes - this.#tailBudget;
    while (excess > 0 && this.#tail.length > 0) {
      const first = this.#tail[0] as Buffer;
      if (first.length <= excess) {
        this.#tail.shift();
        this.#tailBytes -= first.length;
        excess -= first.length;
      } else {
        this.#tail[0] = first.subarray(excess);
        this.#tailBytes -= excess;
        excess = 0;
      }
    }
  }

  /**
   * Mirror the raw chunk to disk.
   *
   * Writes are synchronous: the completion turn is assembled the moment the
   * child closes, and an async stream could still be flushing then, which
   * would make the "complete output" claim false exactly when it matters.
   */
  #spill(chunk: Buffer): void {
    if (!this.#spillPath || this.#spillError || this.#closed) return;
    try {
      if (this.#spillFd === undefined) {
        mkdirSync(dirname(this.#spillPath), { recursive: true, mode: 0o700 });
        this.#spillFd = openSync(this.#spillPath, "a", 0o600);
      }
      writeSync(this.#spillFd, chunk);
    } catch (e) {
      this.#spillError = e instanceof Error ? e.message : String(e);
      if (this.#spillFd !== undefined) {
        try {
          closeSync(this.#spillFd);
        } catch {
          // Already unusable; the error above is what the caller needs.
        }
        this.#spillFd = undefined;
      }
    }
  }
}
