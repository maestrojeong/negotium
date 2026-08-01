/**
 * Fail-closed authorization parsing for the environment-driven Telegram CLI.
 *
 * The adapter itself keeps the permissive `allowedUsers` contract (an empty
 * array means "allow all") because embedders and tests construct it directly
 * and legitimately want an open channel. That default is wrong for the
 * standalone executable: a bot started with only `TELEGRAM_BOT_TOKEN` set used
 * to accept messages from anyone who found it, and every accepted stranger got
 * a full agent session with shell access. Rejection is silent by design, so
 * there was no signal that it was happening.
 *
 * This module is the bootstrap gate. An open channel now requires typing
 * `TELEGRAM_ALLOW_ALL=true`, so it can only happen on purpose.
 */

/** Telegram user ids are positive integers; bot ids fit the same shape. */
const TELEGRAM_USER_ID = /^\d+$/;

export type TelegramAuthConfig =
  | { readonly mode: "allowlist"; readonly allowedUsers: readonly string[] }
  | { readonly mode: "allow-all" };

/**
 * Only the two keys are read, but the shape stays index-signature compatible so
 * `process.env` can be passed straight through.
 */
export type TelegramAuthEnv = Readonly<Record<string, string | undefined>>;

export class TelegramAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramAuthConfigError";
  }
}

function parseAllowAll(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  // Anything else is a typo whose intent we must not guess: silently reading
  // `TELEGRAM_ALLOW_ALL=1` as "off" would be safe but confusing, and as "on"
  // would be dangerous.
  throw new TelegramAuthConfigError(
    `TELEGRAM_ALLOW_ALL must be "true" or "false" (got ${JSON.stringify(raw)}).`,
  );
}

/**
 * Resolve the channel's authorization mode from the environment.
 *
 * @throws {TelegramAuthConfigError} when the configuration would silently
 * expose the bot, is self-contradictory, or lists malformed ids.
 */
export function parseTelegramAuthEnv(env: TelegramAuthEnv): TelegramAuthConfig {
  const allowAll = parseAllowAll(env.TELEGRAM_ALLOW_ALL);
  const entries = (env.TELEGRAM_ALLOWED_USERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (allowAll) {
    if (entries.length > 0) {
      throw new TelegramAuthConfigError(
        "TELEGRAM_ALLOW_ALL=true conflicts with TELEGRAM_ALLOWED_USERS. " +
          "Unset one: the allowlist restricts access, TELEGRAM_ALLOW_ALL removes all restriction.",
      );
    }
    return { mode: "allow-all" };
  }

  if (entries.length === 0) {
    throw new TelegramAuthConfigError(
      "TELEGRAM_ALLOWED_USERS is required: without it every Telegram user who finds this bot " +
        "gets an agent session with shell access. Set it to a comma-separated list of Telegram " +
        "user ids, or set TELEGRAM_ALLOW_ALL=true to accept that risk deliberately.",
    );
  }

  const malformed = entries.filter((entry) => !TELEGRAM_USER_ID.test(entry));
  if (malformed.length > 0) {
    throw new TelegramAuthConfigError(
      `TELEGRAM_ALLOWED_USERS must contain numeric Telegram user ids; ` +
        `rejected ${malformed.map((value) => JSON.stringify(value)).join(", ")}. ` +
        "Usernames and @handles are not accepted because they are mutable.",
    );
  }

  return { mode: "allowlist", allowedUsers: [...new Set(entries)] };
}

/**
 * Translate the resolved mode into the adapter's `allowedUsers` option.
 *
 * The adapter treats an empty array as "allow all", which is exactly what
 * `allow-all` means here — the difference is that reaching this point with an
 * empty array now required an explicit opt-in.
 */
export function allowedUsersForAdapter(config: TelegramAuthConfig): string[] {
  return config.mode === "allow-all" ? [] : [...config.allowedUsers];
}
