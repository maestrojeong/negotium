import { describe, expect, test } from "bun:test";
import {
  allowedUsersForKakaoTalkAdapter,
  KakaoTalkAuthConfigError,
  parseKakaoTalkAuthEnv,
} from "@/env-auth";

describe("parseKakaoTalkAuthEnv — fail closed", () => {
  test("rejects an absent allowlist instead of allowing everyone", () => {
    // The public kakaotalk channel is open to anyone who finds it, so an
    // unset allowlist must not silently become "allow all".
    expect(() => parseKakaoTalkAuthEnv({})).toThrow(KakaoTalkAuthConfigError);
    expect(() => parseKakaoTalkAuthEnv({})).toThrow(
      /NEGOTIUM_KAKAOTALK_ALLOWED_USER_IDS is required/,
    );
  });

  test("rejects an empty or whitespace-only allowlist", () => {
    expect(() => parseKakaoTalkAuthEnv({ NEGOTIUM_KAKAOTALK_ALLOWED_USER_IDS: "" })).toThrow(
      KakaoTalkAuthConfigError,
    );
    expect(() => parseKakaoTalkAuthEnv({ NEGOTIUM_KAKAOTALK_ALLOWED_USER_IDS: "   " })).toThrow(
      KakaoTalkAuthConfigError,
    );
    expect(() => parseKakaoTalkAuthEnv({ NEGOTIUM_KAKAOTALK_ALLOWED_USER_IDS: ", ,," })).toThrow(
      KakaoTalkAuthConfigError,
    );
  });
});

describe("parseKakaoTalkAuthEnv — allowlist mode", () => {
  test("parses, trims, and de-duplicates ids (opaque Kakao user.id hashes, not numeric)", () => {
    const config = parseKakaoTalkAuthEnv({
      NEGOTIUM_KAKAOTALK_ALLOWED_USER_IDS: " abc123XYZ , def456 , abc123XYZ ",
    });
    expect(config).toEqual({ mode: "allowlist", allowedUsers: ["abc123XYZ", "def456"] });
    expect(allowedUsersForKakaoTalkAdapter(config)).toEqual(["abc123XYZ", "def456"]);
  });

  test("NEGOTIUM_KAKAOTALK_ALLOW_ALL=false keeps the allowlist requirement", () => {
    expect(() =>
      parseKakaoTalkAuthEnv({
        NEGOTIUM_KAKAOTALK_ALLOW_ALL: "false",
        NEGOTIUM_KAKAOTALK_ALLOWED_USER_IDS: "",
      }),
    ).toThrow(KakaoTalkAuthConfigError);
    expect(
      parseKakaoTalkAuthEnv({
        NEGOTIUM_KAKAOTALK_ALLOW_ALL: "false",
        NEGOTIUM_KAKAOTALK_ALLOWED_USER_IDS: "abc123",
      }),
    ).toEqual({ mode: "allowlist", allowedUsers: ["abc123"] });
  });
});

describe("parseKakaoTalkAuthEnv — explicit opt-in", () => {
  test("NEGOTIUM_KAKAOTALK_ALLOW_ALL=true yields the open channel the adapter expects", () => {
    const config = parseKakaoTalkAuthEnv({ NEGOTIUM_KAKAOTALK_ALLOW_ALL: "true" });
    expect(config).toEqual({ mode: "allow-all" });
    expect(allowedUsersForKakaoTalkAdapter(config)).toEqual([]);
  });

  test("is case- and whitespace-insensitive", () => {
    expect(parseKakaoTalkAuthEnv({ NEGOTIUM_KAKAOTALK_ALLOW_ALL: " TRUE " }).mode).toBe(
      "allow-all",
    );
  });

  test("refuses to guess at a typo", () => {
    for (const value of ["1", "yes", "on", "TRUEISH"]) {
      expect(() => parseKakaoTalkAuthEnv({ NEGOTIUM_KAKAOTALK_ALLOW_ALL: value })).toThrow(
        /must be "true" or "false"/,
      );
    }
  });

  test("refuses a self-contradictory pair", () => {
    expect(() =>
      parseKakaoTalkAuthEnv({
        NEGOTIUM_KAKAOTALK_ALLOW_ALL: "true",
        NEGOTIUM_KAKAOTALK_ALLOWED_USER_IDS: "abc123",
      }),
    ).toThrow(/conflicts with/);
  });
});
