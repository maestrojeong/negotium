/** One user submission, kept intact while an interrupted turn is replaced. */
export interface UserTurnEnvelope {
  prompt: string;
  attachments?: string[];
  /** Authenticated human author. Execution may still run as the local principal. */
  actorUserId?: string;
  /** Display-only author label captured by the trusted ingress. */
  actorLabel?: string;
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

export function renderUserTurnPrompt(message: UserTurnEnvelope): string {
  const rawLabel = message.actorLabel?.trim() || message.actorUserId?.trim();
  const label = rawLabel
    ?.replace(/[\r\n\t]+/g, " ")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s{2,}/g, " ");
  return label ? `[@${label}]: ${message.prompt}` : message.prompt;
}

/** Render ordered user submissions while retaining their structured authorship. */
export function renderUserTurnBatch(messages: readonly UserTurnEnvelope[]): string {
  return renderUserPromptBatch(messages.map(renderUserTurnPrompt));
}
