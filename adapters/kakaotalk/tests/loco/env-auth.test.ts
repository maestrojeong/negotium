import { describe, expect, test } from "bun:test";
import {
  isLocoSenderAllowed,
  KakaoTalkLocoConfigError,
  parseKakaoTalkLocoAuthEnv,
} from "@/loco/env-auth";

const VALID_UUID = "a".repeat(64);

describe("parseKakaoTalkLocoAuthEnv — disabled by default", () => {
  test("returns disabled when no LOCO email is configured", () => {
    expect(parseKakaoTalkLocoAuthEnv({})).toEqual({ enabled: false });
  });
});

describe("parseKakaoTalkLocoAuthEnv — fail closed once enabled", () => {
  test("rejects a missing password", () => {
    expect(() =>
      parseKakaoTalkLocoAuthEnv({ NEGOTIUM_KAKAOTALK_LOCO_EMAIL: "me@example.com" }),
    ).toThrow(/NEGOTIUM_KAKAOTALK_LOCO_PASSWORD is missing/);
  });

  test("rejects a missing or malformed device uuid", () => {
    expect(() =>
      parseKakaoTalkLocoAuthEnv({
        NEGOTIUM_KAKAOTALK_LOCO_EMAIL: "me@example.com",
        NEGOTIUM_KAKAOTALK_LOCO_PASSWORD: "pw",
      }),
    ).toThrow(KakaoTalkLocoConfigError);
    expect(() =>
      parseKakaoTalkLocoAuthEnv({
        NEGOTIUM_KAKAOTALK_LOCO_EMAIL: "me@example.com",
        NEGOTIUM_KAKAOTALK_LOCO_PASSWORD: "pw",
        NEGOTIUM_KAKAOTALK_LOCO_DEVICE_UUID: "not-hex",
      }),
    ).toThrow(/64-character hex string/);
  });

  test("rejects neither allowlist being set — would open the bot to every room member", () => {
    expect(() =>
      parseKakaoTalkLocoAuthEnv({
        NEGOTIUM_KAKAOTALK_LOCO_EMAIL: "me@example.com",
        NEGOTIUM_KAKAOTALK_LOCO_PASSWORD: "pw",
        NEGOTIUM_KAKAOTALK_LOCO_DEVICE_UUID: VALID_UUID,
      }),
    ).toThrow(/neither .* nor .* is set/);
  });

  test("rejects non-numeric ids in either allowlist", () => {
    expect(() =>
      parseKakaoTalkLocoAuthEnv({
        NEGOTIUM_KAKAOTALK_LOCO_EMAIL: "me@example.com",
        NEGOTIUM_KAKAOTALK_LOCO_PASSWORD: "pw",
        NEGOTIUM_KAKAOTALK_LOCO_DEVICE_UUID: VALID_UUID,
        NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_USER_IDS: "123,abc",
      }),
    ).toThrow(/"abc"/);
  });
});

describe("parseKakaoTalkLocoAuthEnv — enabled", () => {
  test("parses full config with both allowlists", () => {
    const config = parseKakaoTalkLocoAuthEnv({
      NEGOTIUM_KAKAOTALK_LOCO_EMAIL: " me@example.com ",
      NEGOTIUM_KAKAOTALK_LOCO_PASSWORD: "pw",
      NEGOTIUM_KAKAOTALK_LOCO_DEVICE_UUID: VALID_UUID,
      NEGOTIUM_KAKAOTALK_LOCO_DEVICE_NAME: "Galaxy Tab S11",
      NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_USER_IDS: " 111 , 222,111",
      NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_CHAT_IDS: "999",
    });
    expect(config).toEqual({
      enabled: true,
      credentials: {
        email: "me@example.com",
        password: "pw",
        deviceUuid: VALID_UUID,
        deviceName: "Galaxy Tab S11",
      },
      allowedUserIds: ["111", "222"],
      allowedChatIds: ["999"],
    });
  });

  test("either allowlist alone is sufficient", () => {
    expect(
      parseKakaoTalkLocoAuthEnv({
        NEGOTIUM_KAKAOTALK_LOCO_EMAIL: "me@example.com",
        NEGOTIUM_KAKAOTALK_LOCO_PASSWORD: "pw",
        NEGOTIUM_KAKAOTALK_LOCO_DEVICE_UUID: VALID_UUID,
        NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_CHAT_IDS: "999",
      }).enabled,
    ).toBe(true);
  });
});

describe("isLocoSenderAllowed", () => {
  const base = {
    enabled: true as const,
    credentials: { email: "a", password: "b", deviceUuid: VALID_UUID },
  };

  test("both lists configured requires BOTH to match (AND, not OR)", () => {
    const config = { ...base, allowedUserIds: ["111"], allowedChatIds: ["999"] };
    expect(isLocoSenderAllowed(config, 111, 999)).toBe(true);
    expect(isLocoSenderAllowed(config, 111, 888)).toBe(false); // right sender, wrong room
    expect(isLocoSenderAllowed(config, 222, 999)).toBe(false); // right room, wrong sender
  });

  test("an empty list is not a restriction on that axis", () => {
    const userOnly = { ...base, allowedUserIds: ["111"], allowedChatIds: [] };
    expect(isLocoSenderAllowed(userOnly, 111, 12345)).toBe(true);
    expect(isLocoSenderAllowed(userOnly, 222, 12345)).toBe(false);

    const chatOnly = { ...base, allowedUserIds: [], allowedChatIds: ["999"] };
    expect(isLocoSenderAllowed(chatOnly, 54321, 999)).toBe(true);
    expect(isLocoSenderAllowed(chatOnly, 54321, 111)).toBe(false);
  });
});
