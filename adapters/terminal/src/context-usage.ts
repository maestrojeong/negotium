import { estimateTextTokens, type MessageDto } from "@negotium/core";
import type { AppState, TerminalMessage } from "@/state";
import { activeMessages, activeTopic } from "@/state";

export interface ContextBreakdown {
  context: number;
  contextWindow: number;
  confirmed: number;
  user: number;
  assistant: number;
  tools: number;
  free: number;
  estimated: boolean;
}

function latestUsageMessage(
  messages: readonly TerminalMessage[],
): { index: number; usage: NonNullable<MessageDto["usage"]> } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = messages[index]?.authorId === "ai" ? messages[index]?.usage : undefined;
    if (usage?.context !== undefined && usage.contextWindow) return { index, usage };
  }
  return undefined;
}

function estimateMessages(
  messages: readonly TerminalMessage[],
  predicate: (message: TerminalMessage) => boolean,
): number {
  return messages.reduce(
    (sum, message) => (predicate(message) ? sum + 4 + estimateTextTokens(message.text) : sum),
    0,
  );
}

export function activeContextBreakdown(state: AppState): ContextBreakdown | undefined {
  const topic = activeTopic(state);
  if (!topic) return undefined;

  const messages = activeMessages(state);
  const topicUsage = state.topicUsage[topic.id];
  const stored = topicUsage?.currentSession;
  // Compaction rotates the provider session, and the store reports usage only
  // for the session that is live now. So "usage loaded, but no current session"
  // means the context was just reset — and the transcript still holds the
  // pre-compaction usage message, which scanning would resurrect as a full
  // context bar. Only fall back to the transcript while the store has not
  // answered yet.
  const contextWasReset = Boolean(topicUsage) && !stored;
  const latest = contextWasReset ? undefined : latestUsageMessage(messages);
  const confirmed = latest?.usage.context ?? stored?.contextTokens;
  const contextWindow = latest?.usage.contextWindow ?? stored?.contextWindow;
  if (confirmed === undefined || !contextWindow) return undefined;

  const activity = state.activity[topic.id];
  if (!activity?.running) {
    return {
      context: confirmed,
      contextWindow,
      confirmed,
      user: 0,
      assistant: 0,
      tools: 0,
      free: Math.max(0, contextWindow - confirmed),
      estimated: false,
    };
  }

  const afterBaseline = latest
    ? messages.slice(latest.index + 1)
    : stored?.timestamp
      ? messages.filter((message) => message.createdAt > stored.timestamp)
      : messages;
  const user = estimateMessages(
    afterBaseline,
    (message) => message.authorId !== "ai" && message.kind !== "system",
  );
  const assistant =
    activity.contextProgress?.assistantTokens ??
    estimateMessages(
      afterBaseline,
      (message) => message.authorId === "ai" && message.kind !== "tool",
    );
  const tools =
    activity.contextProgress?.toolTokens ??
    estimateMessages(afterBaseline, (message) => message.kind === "tool");
  const context = confirmed + user + assistant + tools;

  return {
    context,
    contextWindow,
    confirmed,
    user,
    assistant,
    tools,
    free: Math.max(0, contextWindow - context),
    estimated: true,
  };
}
