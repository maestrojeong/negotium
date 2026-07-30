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
