/**
 * @negotium/adapter-telegram public API.
 *
 * `startTelegramAdapter` is the whole product: hand it a Telegram client and
 * a negotium node becomes a Telegram bot. Render helpers are exported for
 * hosts that deliver Telegram messages through their own send path.
 */

import { defineNegotiumAdapter } from "@negotium/adapter-sdk";
import { startTelegramAdapter } from "@/adapter";

export type { TelegramAdapterHandle, TelegramAdapterOptions } from "@/adapter";
export type {
  OutboxEntry,
  PersistedMapping,
  PersistedTombstone,
  TelegramMappingStore,
} from "@/mapping-store";
export { openMappingStore } from "@/mapping-store";
export type { OutboundChunk } from "@/render";
export { escapeHtml, markdownToTelegramHtml, renderOutbound, splitMessage } from "@/render";
export type { TelegramClientLike, TelegramIncomingMessage } from "@/types";
export { startTelegramAdapter };

/** Declarative form used by hosts that load adapters from a registry. */
export const telegramAdapter = defineNegotiumAdapter({
  name: "telegram",
  projection: {
    transcript: "live-only",
    historyBackfill: false,
    externalAuthors: "relayed",
  },
  start: startTelegramAdapter,
});
