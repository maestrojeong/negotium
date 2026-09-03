import { elideMiddle, threadTag } from "#runtime/thread-context";

/**
 * The message this submission answers, when it is not simply the previous one.
 *
 * `kind: "thread"` is a reply inside a thread pane — a conversation that keeps
 * going on its own surface. `kind: "quote"` is a one-off pointer at an older
 * message from the main channel flow.
 *
 * `text` is resolved by the runtime from its own canonical store, never taken
 * from the host's request: a host that could supply the quote could put words
 * in another member's mouth.
 */
export interface UserTurnReplyContext {
  kind: "thread" | "quote";
  /** Root message id — present for threads, absent for a plain quote. */
  rootId?: string;
  /** Display label of the quoted author. */
  label?: string;
  /** Quoted body, excerpted at render time. */
  text?: string;
}

/** One user submission, kept intact while an interrupted turn is replaced. */
export interface UserTurnEnvelope {
  prompt: string;
  attachments?: string[];
  /** Authenticated human author. Execution may still run as the local principal. */
  actorUserId?: string;
  /** Display-only author label captured by the trusted ingress. */
  actorLabel?: string;
  /** What this submission replies to, for threads and quoted replies (S-13). */
  replyTo?: UserTurnReplyContext;
}

export function legacyUserTurnEnvelope(prompt: string, attachments?: string[]): UserTurnEnvelope {
  return attachments?.length ? { prompt, attachments } : { prompt };
}

export function flattenUserTurnAttachments(
  messages: readonly UserTurnEnvelope[],
): string[] | undefined {
  const attachments = messages.flatMap((message) => message.attachments ?? []);
  return attachments.length ? attachments : undefined;
}

export function renderUserPromptBatch(prompts: readonly string[]): string {
  if (prompts.length <= 1) return prompts[0] ?? "";
  return [
    "[Consecutive user messages received before an assistant response]",
    "",
    ...prompts.map((prompt, index) => `${index + 1}. ${prompt}`),
  ].join("\n");
}

/**
 * Header naming the message a submission answers.
 *
 * Deliberately *not* the thread's transcript. Every earlier reply in this
 * thread was itself sent through here carrying the same tag, so the session
 * already holds them in order — re-sending them would spend tokens to restate
 * what the model can read above. The excerpt is an anchor, not a delivery: it
 * identifies which message is meant and keeps the turn self-describing if the
 * session is later compacted. When the excerpt is not enough, `thread_read`
 * fetches the thread from the canonical store on demand.
 */
function renderReplyContext(replyTo: UserTurnReplyContext): string | undefined {
  const tag = replyTo.rootId ? ` ${threadTag(replyTo.rootId)}` : "";
  const who = replyTo.label?.trim() ? ` @${elideMiddle(replyTo.label, 48)}` : "";
  const head =
    replyTo.kind === "thread"
      ? `[In thread${tag}${who ? ` on${who}` : ""}]`
      : `[Replying to${who}]`;
  const quoted = replyTo.text?.trim() ? elideMiddle(replyTo.text) : "";
  if (!quoted && !replyTo.rootId && !who) return undefined;
  return quoted ? `${head}\n> ${quoted}` : head;
}

export function renderUserTurnPrompt(message: UserTurnEnvelope): string {
  const rawLabel = message.actorLabel?.trim() || message.actorUserId?.trim();
  const label = rawLabel
    ?.replace(/[\r\n\t]+/g, " ")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s{2,}/g, " ");
  const line = label ? `[@${label}]: ${message.prompt}` : message.prompt;
  const context = message.replyTo ? renderReplyContext(message.replyTo) : undefined;
  return context ? `${context}\n${line}` : line;
}

/** Render ordered user submissions while retaining their structured authorship. */
export function renderUserTurnBatch(messages: readonly UserTurnEnvelope[]): string {
  return renderUserPromptBatch(messages.map(renderUserTurnPrompt));
}
