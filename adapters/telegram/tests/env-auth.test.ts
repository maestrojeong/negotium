import { describe, expect, test } from "bun:test";
import { allowedUsersForAdapter, parseTelegramAuthEnv, TelegramAuthConfigError } from "@/env-auth";

describe("parseTelegramAuthEnv — fail closed", () => {
  test("rejects an absent allowlist instead of allowing everyone", () => {
    // The pre-fix behavior: `undefined` became `[]`, which the adapter reads as
    // allow-all, handing a shell-capable agent session to any stranger.
    expect(() => parseTelegramAuthEnv({})).toThrow(TelegramAuthConfigError);
    expect(() => parseTelegramAuthEnv({})).toThrow(/TELEGRAM_ALLOWED_USERS is required/);
  });

  test("rejects an empty or whitespace-only allowlist", () => {
    expect(() => parseTelegramAuthEnv({ TELEGRAM_ALLOWED_USERS: "" })).toThrow(
      TelegramAuthConfigError,
    );
    expect(() => parseTelegramAuthEnv({ TELEGRAM_ALLOWED_USERS: "   " })).toThrow(
      TelegramAuthConfigError,
    );
    // A list of nothing but separators is still a list of nobody.
    expect(() => parseTelegramAuthEnv({ TELEGRAM_ALLOWED_USERS: ", ,," })).toThrow(
      TelegramAuthConfigError,
    );
  });

  test("names the offending entries for malformed ids", () => {
    expect(() => parseTelegramAuthEnv({ TELEGRAM_ALLOWED_USERS: "123,@alice" })).toThrow(
      /"@alice"/,
    );
    // Mutable identifiers must not be accepted: a username can change hands.
    expect(() => parseTelegramAuthEnv({ TELEGRAM_ALLOWED_USERS: "alice" })).toThrow(
      /numeric Telegram user ids/,
    );
    expect(() => parseTelegramAuthEnv({ TELEGRAM_ALLOWED_USERS: "-1" })).toThrow(
      TelegramAuthConfigError,
    );
    expect(() => parseTelegramAuthEnv({ TELEGRAM_ALLOWED_USERS: "12.5" })).toThrow(
      TelegramAuthConfigError,
    );
  });
});

describe("parseTelegramAuthEnv — allowlist mode", () => {
  test("parses, trims, and de-duplicates ids", () => {
    const config = parseTelegramAuthEnv({ TELEGRAM_ALLOWED_USERS: " 123 , 456,123 " });
    expect(config).toEqual({ mode: "allowlist", allowedUsers: ["123", "456"] });
    expect(allowedUsersForAdapter(config)).toEqual(["123", "456"]);
  });

  test("TELEGRAM_ALLOW_ALL=false keeps the allowlist requirement", () => {
    expect(() =>
      parseTelegramAuthEnv({ TELEGRAM_ALLOW_ALL: "false", TELEGRAM_ALLOWED_USERS: "" }),
    ).toThrow(TelegramAuthConfigError);
    expect(
      parseTelegramAuthEnv({ TELEGRAM_ALLOW_ALL: "false", TELEGRAM_ALLOWED_USERS: "7" }),
    ).toEqual({ mode: "allowlist", allowedUsers: ["7"] });
  });
});

describe("parseTelegramAuthEnv — explicit opt-in", () => {
  test("TELEGRAM_ALLOW_ALL=true yields the open channel the adapter expects", () => {
    const config = parseTelegramAuthEnv({ TELEGRAM_ALLOW_ALL: "true" });
    expect(config).toEqual({ mode: "allow-all" });
    // The adapter's own contract: empty array means allow all. Reaching it now
    // requires having typed the opt-in.
    expect(allowedUsersForAdapter(config)).toEqual([]);
  });

  test("is case- and whitespace-insensitive", () => {
    expect(parseTelegramAuthEnv({ TELEGRAM_ALLOW_ALL: " TRUE " }).mode).toBe("allow-all");
  });

  test("refuses to guess at a typo", () => {
    for (const value of ["1", "yes", "on", "TRUEISH"]) {
      expect(() => parseTelegramAuthEnv({ TELEGRAM_ALLOW_ALL: value })).toThrow(
        /must be "true" or "false"/,
      );
    }
  });

  test("refuses a self-contradictory pair", () => {
    expect(() =>
      parseTelegramAuthEnv({ TELEGRAM_ALLOW_ALL: "true", TELEGRAM_ALLOWED_USERS: "123" }),
    ).toThrow(/conflicts with/);
  });
});
