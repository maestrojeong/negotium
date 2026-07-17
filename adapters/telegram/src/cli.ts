#!/usr/bin/env bun

import type { NegotiumAdapterHandle } from "@negotium/adapter-sdk";
import { isAgentKind, onShutdown, waitForRequiredRuntimeProcessLease } from "@negotium/core";
import { type NodeHandle, startDefaultNode } from "@negotium/node";
import TelegramBot from "node-telegram-bot-api";
import { startTelegramAdapter, type TelegramAdapterHandle } from "@/index";

export interface TelegramEnvironmentHandle extends NegotiumAdapterHandle<"telegram"> {
  readonly adapter: TelegramAdapterHandle;
  readonly bot: TelegramBot;
}

/** Start only the Telegram channel. The embedding host owns the Negotium node. */
export function startTelegramFromEnv(): TelegramEnvironmentHandle {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

  const bot = new TelegramBot(token, { polling: true });
  const requestedAgent = process.env.TELEGRAM_DEFAULT_AGENT?.trim();
  const forumChatId = Number.parseInt(process.env.TELEGRAM_FORUM_CHAT_ID ?? "", 10);
  const adapter = startTelegramAdapter({
    client: bot,
    allowedUsers: (process.env.TELEGRAM_ALLOWED_USERS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    ...(process.env.TELEGRAM_VAULT_OWNER_USER_ID?.trim()
      ? { vaultOwnerTelegramUserId: process.env.TELEGRAM_VAULT_OWNER_USER_ID.trim() }
      : {}),
    ...(isAgentKind(requestedAgent) ? { defaultAgent: requestedAgent } : {}),
    ...(Number.isFinite(forumChatId) ? { forumChatId } : {}),
  });
  let stopped = false;
  return {
    name: "telegram",
    adapter,
    bot,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await adapter.stop();
      await bot.stopPolling({ cancel: true }).catch(() => {});
    },
  };
}

/** Environment-driven executable shipped with `@negotium/adapter-telegram`. */
export async function runTelegramCli(): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  let node: NodeHandle | undefined;
  const singleton = await waitForRequiredRuntimeProcessLease("adapter:telegram", {
    workloadName: "Telegram adapter",
    onLost: () => {
      process.stderr.write("negotium-telegram: singleton lease lost; shutting down\n");
      void node?.stop();
    },
  });
  try {
    // Channel processes coordinate through SQLite, not a shared listening
    // port. An ephemeral port lets Terminal, Telegram, and Otium coexist.
    node = await startDefaultNode({ port: 0 });
  } catch (error) {
    singleton.stop();
    throw error;
  }
  let channel: TelegramEnvironmentHandle;
  try {
    channel = startTelegramFromEnv();
  } catch (error) {
    await node.stop();
    singleton.stop();
    throw error;
  }

  onShutdown("telegram-channel", 100, () => channel.stop());
  onShutdown("telegram-singleton", 90, () => singleton.stop());
  process.stdout.write(`negotium Telegram adapter listening through node :${node.port}\n`);
  await node.completed;
}

if (import.meta.main) {
  runTelegramCli().catch((error) => {
    process.stderr.write(
      `negotium-telegram: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
