/**
 * Terminal rendering for RuntimeBus events — the CLI's half of the host
 * boundary. Deliberately dumb: everything the runtime wants a channel to show
 * arrives on the bus, so this file is the whole "adapter" a channel needs.
 */

import type { MessageDto, RuntimeBusEvent } from "@negotium/core";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

export interface RenderOptions {
  /** Only render events for this topic id (chat mode). Undefined = all. */
  topicId?: string;
  /** Suppress echoing messages authored by this user (they typed them). */
  selfUserId?: string;
}

export function renderBusEvent(event: RuntimeBusEvent, opts: RenderOptions = {}): void {
  if (opts.topicId && event.topicId !== opts.topicId) return;

  switch (event.type) {
    case "message": {
      const msg = event.payload as MessageDto;
      if (opts.selfUserId && msg.authorId === opts.selfUserId) return;
      if (msg.kind === "tool") {
        console.log(dim(`  ${firstLine(msg.text)}`));
        return;
      }
      const author = msg.authorId === "ai" ? cyan(bold("ai")) : bold(msg.authorId);
      console.log(`${author}${msg.agentType ? dim(` (${msg.agentType})`) : ""}: ${msg.text}`);
      return;
    }
    case "message-updated":
      // Edit-in-place progress (tool status, subagent cards) — too chatty for
      // a line-oriented terminal; the final state arrives as ai-status/message.
      return;
    case "ai-status": {
      const status = event.payload as Record<string, unknown>;
      const kind = String(status.kind ?? "");
      if (kind === "ai-active" || kind === "typing") return;
      if (kind === "tool-call") {
        console.log(dim(`  ⚙ ${firstLine(String(status.label ?? status.tool ?? "tool"))}`));
        return;
      }
      if (kind === "error") {
        console.log(red(`  ✖ ${firstLine(String(status.message ?? "error"))}`));
        return;
      }
      if (kind === "aborted") {
        console.log(dim("  ⏹ aborted"));
        return;
      }
      return;
    }
    case "topic-created": {
      const topic = event.payload as { id: string; title?: string };
      console.log(dim(`  + topic created: ${topic.title ?? topic.id}`));
      return;
    }
    case "topic-deleted":
      console.log(dim(`  - topic deleted: ${event.topicId}`));
      return;
    default:
      return;
  }
}

function firstLine(s: string): string {
  const line = s.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
