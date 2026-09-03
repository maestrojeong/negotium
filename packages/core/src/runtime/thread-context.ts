/**
 * Shared vocabulary for naming a thread in text the model reads.
 *
 * A thread reply is already stored apart from the channel — `thread_root_id`
 * plus its own index (`storage/api-messages.ts`) — and it is already sent to
 * the provider session as an ordinary turn. What the session lacks is a *label*:
 * replies from several threads and from the channel arrive as one flat
 * chronological stream, so nothing tells the model which lines belong together.
 *
 * The fix is to name the thread at the moment the prompt is sent, not to
 * re-send the thread's text on every turn. A tag written into the prompt stays
 * in the session forever, so the second reply in a thread can be grouped with
 * the first one by reading the session itself.
 *
 * Kept dependency-free on purpose: the prompt renderer, the channel transcript
 * and the `transcript` MCP server all need the same tag, and only one of the
 * three may import storage.
 */

/** Characters of the root message id used to name a thread. */
export const THREAD_TAG_ID_LENGTH = 6;

/** Default budget for a quoted excerpt of the message being replied to. */
export const THREAD_EXCERPT_MAX_CHARS = 240;

const ELLIPSIS = " … ";

/**
 * Collapse text to one line that cannot be mistaken for our own markup.
 *
 * `[` / `]` become parentheses for the same reason `renderUserTurnPrompt`
 * rewrites author labels: quoted text is attacker-controlled in a shared room,
 * and a quote containing `]: ` would otherwise read as a new author marker.
 */
export function flattenQuotedText(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Shorten from the middle, keeping both ends.
 *
 * Head-only truncation is the wrong shape for the messages people actually
 * reply to. A quoted log or command output states its subject first and its
 * outcome last — cutting the tail keeps "I ran the deploy script:" and throws
 * away the error that the reply is about. The 60/40 split favours the head
 * because identifying the subject costs more characters than recognising a
 * conclusion.
 */
export function elideMiddle(raw: string, limit = THREAD_EXCERPT_MAX_CHARS): string {
  const flat = flattenQuotedText(raw);
  // Cut on grapheme clusters, not UTF-16 code units. `slice` would split an
  // emoji's surrogate pair or detach a combining mark, and the quote is shown
  // to the model as text a person wrote.
  const units = segmentGraphemes(flat);
  if (units.length <= limit) return flat;
  if (limit <= ELLIPSIS.length) return units.slice(0, Math.max(0, limit)).join("");
  const budget = limit - ELLIPSIS.length;
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  const headText = units.slice(0, head).join("").trimEnd();
  // `slice(-0)` is `slice(0)` — the whole string. At small limits the tail
  // budget rounds to zero, so it has to be dropped explicitly rather than
  // sliced, or the "excerpt" comes back longer than the original.
  if (tail <= 0) return `${headText}${ELLIPSIS.trimEnd()}`;
  const tailText = units
    .slice(units.length - tail)
    .join("")
    .trimStart();
  return `${headText}${ELLIPSIS}${tailText}`;
}

/** Grapheme clusters where the platform can, code points otherwise. */
function segmentGraphemes(value: string): string[] {
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locales?: string,
        options?: { granularity?: "grapheme" },
      ) => { segment(input: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (!Segmenter) return Array.from(value);
  const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
  const out: string[] = [];
  for (const { segment } of segmenter.segment(value)) out.push(segment);
  return out;
}

/**
 * Stable short name for a thread, e.g. `#a3f1c8`.
 *
 * Short enough to repeat on every turn without noticeable cost, and derived
 * from the root id so the same thread always gets the same name across turns,
 * sessions and processes. Collisions inside one room are possible in principle
 * and harmless in practice: the tag groups lines for a reader, it is never used
 * to look a message up.
 */
export function threadTag(rootId: string): string {
  const compact = rootId.replace(/[^0-9A-Za-z]/g, "");
  return `#${(compact || rootId).slice(0, THREAD_TAG_ID_LENGTH)}`;
}

/**
 * How a quoted message's author is named to the model.
 *
 * Structural on purpose so both the canonical DTO and a raw storage row can be
 * passed without this module importing either.
 */
export function describeQuotedAuthor(message: {
  authorId: string;
  authorName?: string | null;
  agentType?: string | null;
}): string {
  if (message.authorId === "ai") {
    return message.agentType ? `AI (${message.agentType})` : "AI";
  }
  return message.authorName?.trim() || message.authorId;
}
