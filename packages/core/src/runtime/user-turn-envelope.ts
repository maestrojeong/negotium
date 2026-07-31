/** One user submission, kept intact while an interrupted turn is replaced. */
export interface UserTurnEnvelope {
  prompt: string;
  attachments?: string[];
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
