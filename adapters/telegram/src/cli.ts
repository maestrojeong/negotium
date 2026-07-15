#!/usr/bin/env bun

import type { NegotiumAdapterHandle } from "@negotium/adapter-sdk";
import { acquireRuntimeProcessLease, getRuntimeProcessLease, isAgentKind } from "@negotium/core";
import { startDefaultNode } from "@negotium/node";
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
  let leaseLost = false;
  let stopForLeaseLoss: (() => void) | undefined;
  const singleton = acquireRuntimeProcessLease("adapter:telegram", {
    onLost: () => {
      leaseLost = true;
      process.stderr.write("negotium-telegram: singleton lease lost; shutting down\n");
      stopForLeaseLoss?.();
    },
  });
  if (!singleton) {
    const current = getRuntimeProcessLease("adapter:telegram");
    throw new Error(`Telegram adapter is already running${current ? ` (pid ${current.pid})` : ""}`);
  }
  let node: Awaited<ReturnType<typeof startDefaultNode>>;
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

  process.stdout.write(`negotium Telegram adapter listening through node :${node.port}\n`);
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void Promise.resolve(channel.stop())
        .catch(() => {})
        .then(() => node.stop())
        .catch(() => {})
        .finally(() => singleton.stop())
        .finally(resolve);
    };
    stopForLeaseLoss = stop;
    if (leaseLost) stop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

if (import.meta.main) {
  runTelegramCli().catch((error) => {
    process.stderr.write(
      `negotium-telegram: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
