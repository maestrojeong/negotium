/**
 * @negotium/adapter-kakaotalk public API.
 *
 * `startKakaoTalkAdapter` turns a negotium node into a KakaoTalk channel
 * bot backed by Kakao i Open Builder. See README.md for the Kakao Developers
 * Console / Open Builder setup this depends on.
 */

import { defineNegotiumAdapter } from "@negotium/adapter-sdk";
import { startKakaoTalkAdapter } from "@/adapter";
import { createKakaoTalkModule } from "@/module";

export type { KakaoTalkAdapterHandle, KakaoTalkAdapterOptions } from "@/adapter";
export {
  allowedUsersForKakaoTalkAdapter,
  type KakaoTalkAuthConfig,
  KakaoTalkAuthConfigError,
  type KakaoTalkAuthEnv,
  parseKakaoTalkAuthEnv,
} from "@/env-auth";
export {
  isLocoSenderAllowed,
  type KakaoTalkLocoAuthEnv,
  type KakaoTalkLocoConfig,
  KakaoTalkLocoConfigError,
  type KakaoTalkLocoCredentials,
  parseKakaoTalkLocoAuthEnv,
} from "@/loco/env-auth";
export { KAKAOTALK_WEBHOOK_PATH } from "@/webhook";
export { createKakaoTalkModule, startKakaoTalkAdapter };

/** Declarative form used by hosts that load adapters from a registry. */
export const kakaotalkAdapter = defineNegotiumAdapter({
  name: "kakaotalk",
  capabilities: {
    // Inbound text does reach core (persisted + occasionally turned into a
    // turn), but never as a direct 1:1 "local user input" relay the way
    // telegram/terminal mean it — it's gated by the word trigger.
    localUserInput: false,
    topicManagement: false,
    externalPlacedTurn: false,
  },
  projection: {
    transcript: "live-only",
    historyBackfill: false,
    externalAuthors: "relayed",
  },
  start: startKakaoTalkAdapter,
});
