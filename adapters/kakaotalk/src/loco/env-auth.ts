/**
 * Fail-closed configuration + authorization parsing for the LOCO transport.
 *
 * Mirrors ../env-auth.ts (the Open Builder transport's parser), but LOCO
 * gives us something Open Builder structurally cannot: a real, stable
 * `chatId` per room (devtalk.kakao.com/t/topic/133154 — Open Builder's
 * skill payload has no such field at all). So unlike the Open Builder path,
 * which can only ever filter by sender, this can honor BOTH halves of the
 * original ask — "only me" (NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_USER_IDS) AND
 * "only rooms I invited the bot into"
 * (NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_CHAT_IDS).
 *
 * LOCO's `userId`/`chatId` are Java `long`s (plain decimal numbers), unlike
 * Open Builder's opaque `user.id` hash strings — so these lists are
 * validated as numeric, like the telegram adapter's user-id allowlist.
 */

const NUMERIC_ID = /^\d+$/;

export interface KakaoTalkLocoCredentials {
  email: string;
  password: string;
  deviceUuid: string;
  deviceName?: string;
}

export type KakaoTalkLocoConfig =
  | {
      readonly enabled: true;
      readonly credentials: KakaoTalkLocoCredentials;
      readonly allowedUserIds: readonly string[];
      readonly allowedChatIds: readonly string[];
    }
  | { readonly enabled: false };

export type KakaoTalkLocoAuthEnv = Readonly<Record<string, string | undefined>>;

export class KakaoTalkLocoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KakaoTalkLocoConfigError";
  }
}

function parseIdList(raw: string | undefined, envVarName: string): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const malformed = entries.filter((entry) => !NUMERIC_ID.test(entry));
  if (malformed.length > 0) {
    throw new KakaoTalkLocoConfigError(
      `${envVarName} must contain numeric LOCO ids; rejected ${malformed
        .map((value) => JSON.stringify(value))
        .join(", ")}.`,
    );
  }
  return [...new Set(entries)];
}

/**
 * Resolve the LOCO transport's config from the environment. Returns
 * `{ enabled: false }` when `NEGOTIUM_KAKAOTALK_LOCO_EMAIL` is unset — LOCO
 * is opt-in on top of the (already opt-in) kakaotalk surface, since it
 * requires a real personal account's credentials and carries its own
 * distinct risk (see adapters/kakaotalk/README.md).
 *
 * @throws {KakaoTalkLocoConfigError} when LOCO is enabled but misconfigured
 * in a way that would silently expose the bot to every member of every room
 * it's invited into (no allowlist at all), or that has malformed id lists.
 */
export function parseKakaoTalkLocoAuthEnv(env: KakaoTalkLocoAuthEnv): KakaoTalkLocoConfig {
  const email = env.NEGOTIUM_KAKAOTALK_LOCO_EMAIL?.trim();
  if (!email) return { enabled: false };

  const password = env.NEGOTIUM_KAKAOTALK_LOCO_PASSWORD?.trim();
  const deviceUuid = env.NEGOTIUM_KAKAOTALK_LOCO_DEVICE_UUID?.trim();
  if (!password) {
    throw new KakaoTalkLocoConfigError(
      "NEGOTIUM_KAKAOTALK_LOCO_EMAIL is set but NEGOTIUM_KAKAOTALK_LOCO_PASSWORD is missing.",
    );
  }
  if (!deviceUuid || deviceUuid.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(deviceUuid)) {
    throw new KakaoTalkLocoConfigError(
      "NEGOTIUM_KAKAOTALK_LOCO_DEVICE_UUID must be a 64-character hex string " +
        "(generate one once and keep it stable — it identifies this sub-device to Kakao).",
    );
  }

  const allowedUserIds = parseIdList(
    env.NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_USER_IDS,
    "NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_USER_IDS",
  );
  const allowedChatIds = parseIdList(
    env.NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_CHAT_IDS,
    "NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_CHAT_IDS",
  );
  if (allowedUserIds.length === 0 && allowedChatIds.length === 0) {
    throw new KakaoTalkLocoConfigError(
      "LOCO is enabled (NEGOTIUM_KAKAOTALK_LOCO_EMAIL is set) but neither " +
        "NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_USER_IDS nor NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_CHAT_IDS is set — " +
        "without at least one, every member of every room this account is in can trigger a real AI turn. " +
        "Set at least one allowlist (both is stronger: sender AND room must match).",
    );
  }

  return {
    enabled: true,
    credentials: {
      email,
      password,
      deviceUuid,
      ...(env.NEGOTIUM_KAKAOTALK_LOCO_DEVICE_NAME?.trim()
        ? { deviceName: env.NEGOTIUM_KAKAOTALK_LOCO_DEVICE_NAME.trim() }
        : {}),
    },
    allowedUserIds,
    allowedChatIds,
  };
}

/** Both configured lists must match (when non-empty) — AND, not OR, since each is a real boundary. */
export function isLocoSenderAllowed(
  config: Extract<KakaoTalkLocoConfig, { enabled: true }>,
  userId: number,
  chatId: number,
): boolean {
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(String(userId))) {
    return false;
  }
  if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(String(chatId))) {
    return false;
  }
  return true;
}
