import { writeSync } from "node:fs";

/**
 * Emergency terminal-state restore.
 *
 * The TUI puts the terminal into a state the shell cannot recover from on its
 * own: alternate screen, hidden cursor, a forced background colour, mouse
 * reporting and the kitty keyboard protocol. Every one of those is undone by
 * `EXIT_ALT_SCREEN`, so the only question is whether that string reaches the
 * terminal on *every* way out of the process.
 *
 * Two properties matter and neither is satisfied by the obvious implementation:
 *
 * 1. The write must be synchronous. `process.stdout.write()` queues onto libuv
 *    and a `process.on("exit")` callback returns before that queue is drained,
 *    so the bytes are dropped. `fs.writeSync(1, ...)` is the only form that is
 *    guaranteed to have hit the fd by the time the callback returns.
 * 2. SIGHUP must be handled. It is what a terminal emulator and an SSH server
 *    send when the connection goes away, its default disposition is immediate
 *    termination, and without a handler the restore sequence is never emitted —
 *    which is exactly how a shell ends up stuck on the TUI background colour.
 *
 * 3. The write can fail *partially*, and a failed restore must stay retryable.
 *    `writeSync` returns a byte count and can raise `EAGAIN`/`EINTR` on a busy
 *    fd. Treating "we tried" as "we restored" left the terminal broken for good
 *    the first time either happened, so completion is tracked separately from
 *    the reentrancy guard (see {@link restore}).
 *
 * Everything here is a module-level singleton because the hooks are process
 * global. negotium can be embedded, so the hooks exist only while the TUI owns
 * the terminal and are removed again by the disposer — and the crash hooks are
 * chosen so that an embedding host's own error policy still wins.
 */

/** Signal numbers used for the conventional `128 + signo` exit status. */
const SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;

type RestoreSignal = keyof typeof SIGNAL_NUMBERS;

export interface TerminalRestoreOptions {
  /**
   * Asks the app for a graceful shutdown after the emergency restore has
   * already been written. Never called for the forced second-signal path.
   */
  onSignal?: (signal: RestoreSignal) => void;
  /**
   * Synchronous writer. Overridden in tests; defaults to `writeSync(1, …)`.
   *
   * Returns the number of *bytes* accepted, exactly like `writeSync`.
   * `undefined` means "all of it", which is what a test double that cannot
   * short-write returns.
   */
  write?: (sequence: string) => number | undefined;
  /** Overridden in tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Overridden in tests; defaults to `writeSync(2, …)`. */
  writeError?: (text: string) => void;
}

interface RestoreState {
  /** Bytes still owed to the terminal; empty once the restore is complete. */
  pending: Buffer;
  /** True once every byte has actually reached the fd. */
  done: boolean;
  /** Reentrancy guard: a signal arriving mid-write must not re-enter the loop. */
  writing: boolean;
  /**
   * The owner has let go, but the hooks may still be up because the restore has
   * not succeeded yet. Ownership and "is there still a pending restore" are two
   * different questions and were conflated before.
   */
  released: boolean;
  signalCounts: Map<RestoreSignal, number>;
  write: (sequence: string) => number | undefined;
  writeError: (text: string) => void;
  exit: (code: number) => void;
  onSignal?: (signal: RestoreSignal) => void;
  detach: () => void;
}

let state: RestoreState | null = null;

/**
 * Bounded retries for a single restore attempt.
 *
 * This runs on the way out of the process, sometimes from a signal handler, so
 * spinning until the fd drains is not an option: a wedged terminal would hang
 * the exit forever. Eight attempts is enough to walk through a short-write of a
 * sequence this size; anything beyond that is left for the next hook (`exit`
 * always fires) rather than blocking here.
 */
const MAX_WRITE_ATTEMPTS = 8;

/** Transient `writeSync` failures: the fd is alive, it just is not ready yet. */
const RETRYABLE_WRITE_ERRORS = new Set(["EAGAIN", "EWOULDBLOCK", "EINTR"]);

function isRetryable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_WRITE_ERRORS.has(code);
}

function defaultWrite(sequence: string): number {
  return writeSync(1, sequence);
}

function defaultWriteError(text: string): void {
  writeSync(2, text);
}

/**
 * Pushes the restore sequence to the terminal, resuming where a previous
 * attempt stopped.
 *
 * The reentrancy guard and the completion flag are deliberately separate. They
 * used to be one flag set *before* the write, so a single `EAGAIN` — or a short
 * write nobody looked at — marked the terminal restored forever and every later
 * hook (including the normal `exit` path) skipped it. A failed restore is a
 * shell left on the TUI background colour with no cursor, so it has to stay
 * retryable.
 *
 * All restore sequences are ASCII, so a byte count from `writeSync` indexes the
 * pending buffer directly.
 *
 * @returns whether the terminal is now restored. `false` means bytes are still
 * owed and the caller must leave the hooks up so a later path can retry.
 */
function restore(current: RestoreState): boolean {
  if (current.done) return true;
  if (current.writing) return false;
  current.writing = true;
  try {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS && current.pending.length > 0; attempt++) {
      let written: number | undefined;
      try {
        written = current.write(current.pending.toString("utf8"));
      } catch (error) {
        // A closed or full stdout (EPIPE/EAGAIN) must never turn into a crash
        // that replaces the real reason the process is going down.
        if (!isRetryable(error)) break;
        continue;
      }
      if (written === undefined || written >= current.pending.length) {
        current.pending = Buffer.alloc(0);
        break;
      }
      // A zero-byte write made no progress; the attempt budget bounds the spin.
      if (written > 0) current.pending = current.pending.subarray(written);
    }
    if (current.pending.length === 0) current.done = true;
  } finally {
    current.writing = false;
  }
  return current.done;
}

/**
 * Restores the terminal if a TUI currently owns it. Safe to call at any time,
 * including from a handler racing the normal cleanup path.
 */
export function restoreTerminalNow(): void {
  if (state) restore(state);
}

/**
 * Swaps the sequence the installed hooks will emit.
 *
 * Terminal setup happens in stages: the hooks go up *before* the first byte is
 * written (so a crash mid-`enter` is still covered), but at that point only the
 * idempotent mode resets are safe to emit — see `abortEnter` in
 * `altScreenSequences`. Once the alternate screen is really entered, the owner
 * upgrades to the full restore, background reset and kitty pop included.
 *
 * Ignored once the restore has already been written: the terminal is back in a
 * known state and re-arming it with a longer sequence would only risk emitting
 * the non-idempotent parts twice.
 */
export function upgradeTerminalRestore(sequence: string): void {
  if (!state || state.done || state.writing) return;
  state.pending = Buffer.from(sequence, "utf8");
}

/** True while emergency hooks are installed. Exposed for tests. */
export function terminalRestoreInstalled(): boolean {
  return state !== null;
}

/** Thrown when a second TUI tries to take a terminal another one already owns. */
export class TerminalAlreadyOwnedError extends Error {
  constructor() {
    super(
      "another negotium terminal adapter already owns this terminal; stop it before starting another",
    );
    this.name = "TerminalAlreadyOwnedError";
  }
}

/**
 * Claims the terminal for one TUI and returns the release function.
 *
 * Ownership is exclusive, and a second claim throws. Two TUIs cannot share one
 * terminal in any useful sense — this was measured, not assumed: each writes its
 * own `ENTER_ALT_SCREEN`, so the kitty keyboard flag is pushed twice and popped
 * once, and whichever app finishes first calls `setRawMode(false)` and
 * `stdin.pause()` on the *process-global* stdin, killing input for the one still
 * running. Reference counting the restore hooks (the previous attempt here)
 * guaranteed the restore write but fixed none of that.
 *
 * So the failure is surfaced instead of papered over: the second adapter is
 * rejected before it writes a single byte to the terminal, which leaves the
 * first one's alternate screen, raw mode and hooks exactly as they were. The
 * claim is released by the disposer, so a host may start a new adapter once the
 * previous one has finished.
 *
 * @throws {TerminalAlreadyOwnedError} if another adapter already owns the terminal.
 */
export function installTerminalRestore(
  sequence: string,
  options: TerminalRestoreOptions = {},
): () => void {
  if (state && !state.released) throw new TerminalAlreadyOwnedError();
  if (state) {
    // A previous owner let go while its restore was still failing, so its hooks
    // are still up waiting for a retry. The incoming adapter is about to
    // reconfigure the terminal and its own exit sequence resets everything the
    // old one set, so the stale attempt is dropped rather than layered.
    state.detach();
    state = null;
  }

  const current: RestoreState = {
    pending: Buffer.from(sequence, "utf8"),
    done: false,
    writing: false,
    released: false,
    signalCounts: new Map(),
    write: options.write ?? defaultWrite,
    writeError: options.writeError ?? defaultWriteError,
    exit: options.exit ?? ((code: number) => process.exit(code)),
    onSignal: options.onSignal,
    detach: () => {},
  };

  const onExit = () => {
    restore(current);
  };

  const makeSignalHandler = (signal: RestoreSignal) => () => {
    const seen = (current.signalCounts.get(signal) ?? 0) + 1;
    current.signalCounts.set(signal, seen);
    // The first signal restores and asks for a graceful shutdown. A repeat of
    // the same signal means the user is hammering Ctrl-C because shutdown is
    // taking too long, so leave immediately instead of swallowing it — without
    // `process.exit` here the default disposition is gone and the TUI would be
    // unkillable by Ctrl-C.
    if (seen > 1) {
      restore(current);
      current.exit(128 + SIGNAL_NUMBERS[signal]);
      return;
    }
    restore(current);
    current.onSignal?.(signal);
  };

  // Observe-only. `uncaughtExceptionMonitor` runs before any
  // `uncaughtException` listener and before the default fatal handler prints
  // the stack trace, which is the ordering that matters: a trace written while
  // the alternate screen is still up is erased the instant the terminal
  // switches back. Unlike a real `uncaughtException` listener it does not
  // change what the process does next, so an embedding host keeps whatever
  // error policy it designed — including recovering and carrying on.
  //
  // The trade-off, accepted deliberately: on an error the host recovers from,
  // the terminal is restored anyway and a still-running TUI is left outside the
  // alternate screen. Leaving a *dead* process's terminal unusable is worse
  // than making a live one repaint.
  const onUncaughtExceptionMonitor = (_error: unknown) => {
    restore(current);
  };

  // Bun (measured on 1.2.15) does not route an unhandled rejection through
  // `uncaughtException`, so the monitor above never sees one. There is no
  // `unhandledRejectionMonitor` either, so this is a real listener — but it is
  // written to behave like a monitor.
  //
  // It is *prepended* (verified on Bun 1.2.15: prepended listeners run first)
  // so the restore lands before an embedding host's own handler writes its
  // diagnostics. That is the whole point of the hook: a stack trace printed
  // onto the alternate screen vanishes when the terminal switches back.
  //
  // Whether it also ends the process is decided at fire time, not install time,
  // so a host that registers its handler later is still respected:
  //
  //  - Another listener exists → the host owns the outcome. Restore and return;
  //    we neither print nor exit on its behalf.
  //  - We are the only listener → without us the runtime would have made this
  //    fatal, and merely attaching a listener would silently turn a crash into
  //    a hang. Keep the default: report and exit non-zero.
  const onUnhandledRejection = (reason: unknown) => {
    restore(current);
    if (process.listenerCount("unhandledRejection") > 1) return;
    try {
      current.writeError(
        `\nnegotium terminal adapter crashed (unhandled rejection):\n${formatError(reason)}\n`,
      );
    } catch {
      /* ignore */
    }
    current.exit(1);
  };

  const signalHandlers = new Map<RestoreSignal, () => void>();
  process.on("exit", onExit);
  process.on("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
  process.prependListener("unhandledRejection", onUnhandledRejection);
  for (const signal of Object.keys(SIGNAL_NUMBERS) as RestoreSignal[]) {
    const handler = makeSignalHandler(signal);
    try {
      // `on`, not `once`: the second Ctrl-C has to reach the forced-exit path.
      process.on(signal, handler);
      signalHandlers.set(signal, handler);
    } catch {
      // SIGHUP does not exist on every platform (Windows). Losing one signal
      // must not cost us the others.
    }
  }

  current.detach = () => {
    process.off("exit", onExit);
    process.off("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
    process.off("unhandledRejection", onUnhandledRejection);
    for (const [signal, handler] of signalHandlers) {
      try {
        process.off(signal, handler);
      } catch {
        /* ignore */
      }
    }
  };

  state = current;

  let released = false;
  return () => {
    if (released || state !== current) return;
    released = true;
    current.released = true;
    // Only tear the hooks down once the terminal is actually back. A restore
    // that exhausted its retries still owes the terminal bytes, and detaching
    // here would throw away the last chance to send them — `process.on("exit")`
    // fires later, on a quieter fd, with a fresh attempt budget.
    if (restore(current)) {
      current.detach();
      state = null;
    }
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}
