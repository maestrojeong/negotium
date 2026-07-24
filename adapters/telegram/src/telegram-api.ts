import type { TelegramChatMember } from "@/types";

export interface TelegramErrorInfo {
  status?: number;
  code?: string;
  description: string;
  retryAfterSec?: number;
}

const RETRYABLE_CODES = new Set(["EFATAL", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"]);

export function onboardingGuide(botUsername?: string): string {
  const identity = botUsername ? `\nBot username: @${botUsername.replace(/^@/, "")}\n` : "\n";
  return (
    "Welcome to Negotium. This DM is your General manager: chat naturally here to create, " +
    "delegate work to, stop, or delete topics.\n\n" +
    "Connect a Telegram workspace:\n" +
    "1. Create a supergroup and enable Topics.\n" +
    "2. Add this bot to the group.\n" +
    '3. Promote the bot to administrator and enable "Manage Topics".\n' +
    "4. The group connects automatically; no /connect command is needed.\n" +
    identity +
    "After connection, use the group's General topic as the manager and each forum topic as " +
    "an independent agent conversation."
  );
}

export function isChatAdmin(member: TelegramChatMember): boolean {
  return member.status === "administrator" || member.status === "creator";
}

export function canManageTopics(member: TelegramChatMember): boolean {
  return (
    member.status === "creator" ||
    (member.status === "administrator" && member.can_manage_topics === true)
  );
}

export function isManageTopicsPermissionError(info: TelegramErrorInfo): boolean {
  return /not enough rights|need administrator rights|chat_admin_required|manage topics/i.test(
    info.description,
  );
}

export function defaultTopicTitle(chatId: number, threadId?: number): string {
  return threadId === undefined ? `tg-${chatId}` : `tg-${chatId}-${threadId}`;
}

export function extractCommandArg(text: string): string {
  return text.split(/\s+/).slice(1).join(" ").trim();
}

export function telegramErrorInfo(err: unknown): TelegramErrorInfo {
  const error = err as {
    message?: unknown;
    code?: unknown;
    response?: {
      statusCode?: unknown;
      body?: { description?: unknown; parameters?: { retry_after?: unknown } };
    };
  };
  const status =
    typeof error?.response?.statusCode === "number" ? error.response.statusCode : undefined;
  const description = [error?.response?.body?.description, error?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const retryRaw = error?.response?.body?.parameters?.retry_after;
  return {
    status,
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
    description,
    ...(typeof retryRaw === "number" ? { retryAfterSec: retryRaw } : {}),
  };
}

export function isHtmlParseError(info: TelegramErrorInfo): boolean {
  if (info.status !== undefined && info.status !== 400) return false;
  return /can't parse entities/i.test(info.description);
}

export function isForumTopicAlreadyGone(info: TelegramErrorInfo): boolean {
  if (info.status !== undefined && info.status !== 400) return false;
  return /(?:message thread|forum topic).*not found|topic_id_invalid/i.test(info.description);
}

export function isRetryableSendError(info: TelegramErrorInfo): boolean {
  if (info.status === 429) return true;
  if (info.status !== undefined && info.status >= 500 && info.status < 600) return true;
  return info.code !== undefined && RETRYABLE_CODES.has(info.code);
}
