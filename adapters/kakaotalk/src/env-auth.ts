/**
 * Fail-closed authorization parsing for the kakaotalk adapter's node wiring.
 *
 * Mirrors adapters/telegram/src/env-auth.ts. The kakaotalk channel this
 * adapter answers through is a PUBLIC KakaoTalk channel: once it is wired to
 * an Open Builder skill server, anyone who finds and messages the channel —
 * including every participant of any open-chat room it is invited into, not
 * just the operator — reaches this node's webhook. Kakao's skill request
 * does not expose a stable chat/room identifier (only `userRequest.user.id`
 * reliably distinguishes senders, confirmed via Kakao's own devtalk:
 * https://devtalk.kakao.com/t/topic/133154), so sender-id whitelisting is
 * the only enforceable boundary — there is no way to scope "only inside
 * rooms I invited the bot to" more precisely than "only when I am the one
 * typing", which this achieves regardless of which room the message is in.
 *
 * `userRequest.user.id` is an opaque hash, not a numeric Telegram-style id,
 * so unlike Telegram's parser this does not validate id shape — any
 * non-empty string is accepted.
 */

/** The kakaotalk adapter's env-driven CLI/module wiring reads these two keys. */
export type KakaoTalkAuthEnv = Readonly<Record<string, string | undefined>>;

export type KakaoTalkAuthConfig =
  | { readonly mode: "allowlist"; readonly allowedUsers: readonly string[] }
  | { readonly mode: "allow-all" };

export class KakaoTalkAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KakaoTalkAuthConfigError";
  }
}

function parseAllowAll(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new KakaoTalkAuthConfigError(
    `NEGOTIUM_KAKAOTALK_ALLOW_ALL must be "true" or "false" (got ${JSON.stringify(raw)}).`,
  );
}

/**
 * Resolve the kakaotalk channel's authorization mode from the environment.
 *
 * @throws {KakaoTalkAuthConfigError} when the configuration would silently
 * expose the bot to the public channel, or is self-contradictory.
 */
export function parseKakaoTalkAuthEnv(env: KakaoTalkAuthEnv): KakaoTalkAuthConfig {
  const allowAll = parseAllowAll(env.NEGOTIUM_KAKAOTALK_ALLOW_ALL);
  const entries = (env.NEGOTIUM_KAKAOTALK_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (allowAll) {
    if (entries.length > 0) {
      throw new KakaoTalkAuthConfigError(
        "NEGOTIUM_KAKAOTALK_ALLOW_ALL=true conflicts with NEGOTIUM_KAKAOTALK_ALLOWED_USER_IDS. " +
          "Unset one: the allowlist restricts access, ALLOW_ALL removes all restriction.",
      );
    }
    return { mode: "allow-all" };
  }

  if (entries.length === 0) {
    throw new KakaoTalkAuthConfigError(
      "NEGOTIUM_KAKAOTALK_ALLOWED_USER_IDS is required: without it every KakaoTalk user who finds " +
        "the public channel — including every other participant of any open-chat room the bot is " +
        "invited into — can trigger a real AI turn on this node. Set it to a comma-separated list " +
        "of KakaoTalk userRequest.user.id values (logged for an unrecognized sender once the webhook " +
        "is live, so the first real message bootstraps the value to add), or set " +
        "NEGOTIUM_KAKAOTALK_ALLOW_ALL=true to accept that risk deliberately.",
    );
  }

  return { mode: "allowlist", allowedUsers: [...new Set(entries)] };
}

/**
 * Translate the resolved mode into the adapter's `allowedUsers` option.
 *
 * The adapter treats an empty array as "allow all" (same convention as the
 * telegram adapter) — reaching that here now required the explicit opt-in.
 */
export function allowedUsersForKakaoTalkAdapter(config: KakaoTalkAuthConfig): string[] {
  return config.mode === "allow-all" ? [] : [...config.allowedUsers];
}
