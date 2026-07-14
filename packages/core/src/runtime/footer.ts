/**
 * Turn footer — the one-line "agent · model · tokens" trailer appended to
 * final AI replies. Lives in core so every channel (Telegram adapter, CLI,
 * web) renders the same footer from the same MessageDto fields; channels
 * only decide the dim/italic styling of the returned plain string.
 *
 * Ported from clawgram's `query/footer.ts` semantics, minus the
 * show-only-on-config-change memory (channel adapters opt in per message).
 */

import type { MessageDto } from "#types/api";

/** Render the footer for a final AI message, or null when the payload
 *  carries nothing worth showing (no agent/model/usage). */
export function renderTurnFooter(
  msg: Pick<MessageDto, "agentType" | "model" | "usage">,
): string | null {
  const parts: string[] = [];
  if (msg.agentType) parts.push(msg.agentType);
  if (msg.model) parts.push(msg.model);
  if (msg.usage) parts.push(`↑${msg.usage.input} ↓${msg.usage.output} tok`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
