#!/usr/bin/env bun

import type { NegotiumAdapterHandle } from "@negotium/adapter-sdk";
import {
  isAgentKind,
  LOG_DIR,
  NODE_CONTROL_TOKEN,
  onShutdown,
  runShutdown,
  waitForRequiredRuntimeProcessLease,
} from "@negotium/core";
import { inspectNodeDaemon, NODE_CONTROL_BASE_PATH, waitForNodeDaemon } from "@negotium/node";
import TelegramBot from "node-telegram-bot-api";
import {
  startTelegramAdapter,
  type TelegramAdapterHandle,
  type TelegramAdapterOptions,
} from "@/index";

export interface TelegramEnvironmentHandle extends NegotiumAdapterHandle<"telegram"> {
  readonly adapter: TelegramAdapterHandle;
  readonly bot: TelegramBot;
}

/** Start only the Telegram channel. The embedding host owns the Negotium node. */
export function startTelegramFromEnv(
  options: Pick<TelegramAdapterOptions, "abortTurn" | "submitTurn"> = {},
): TelegramEnvironmentHandle {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

  const bot = new TelegramBot(token, { polling: true });
  const requestedAgent = process.env.TELEGRAM_DEFAULT_AGENT?.trim();
  const forumChatId = Number.parseInt(process.env.TELEGRAM_FORUM_CHAT_ID ?? "", 10);
  const adapter = startTelegramAdapter({
    ...options,
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

async function spawnCanonicalNode(): Promise<void> {
  const entry = process.argv[1];
  if (!entry) throw new Error("cannot locate the Negotium CLI entrypoint");
  const child = Bun.spawn({
    cmd: [process.execPath, entry, "__node-daemon", "--port=0"],
    detached: true,
    env: { ...process.env, LOG_LEVEL: process.env.NEGOTIUM_NODE_LOG_LEVEL?.trim() || "info" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: Bun.file(`${LOG_DIR}/node-daemon.log`),
  });
  child.unref();
}

async function ensureCanonicalNode(): Promise<import("@negotium/node").NodeDaemonConnection> {
  const status = await inspectNodeDaemon();
  if (!status.running) await spawnCanonicalNode();
  return waitForNodeDaemon(15_000);
}

async function runCanonicalNodeChild(): Promise<void> {
  const { runNodeDaemon } = await import("@negotium/node");
  await runNodeDaemon({ port: 0 });
}

/** Environment-driven executable shipped with `@negotium/adapter-telegram`. */
export async function runTelegramCli(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === "__node-daemon") {
    await runCanonicalNodeChild();
    return;
  }
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  const initialNode = await ensureCanonicalNode();
  const singleton = await waitForRequiredRuntimeProcessLease("adapter:telegram", {
    workloadName: "Telegram adapter",
    onLost: () => {
      process.stderr.write("negotium-telegram: singleton lease lost; shutting down\n");
      void runShutdown("test");
    },
  });
  let channel: TelegramEnvironmentHandle;
  try {
    channel = startTelegramFromEnv({
      abortTurn: async (topicId, userId) => {
        const node = await waitForNodeDaemon(1_500);
        const response = await fetch(
          `${node.baseUrl}${NODE_CONTROL_BASE_PATH}/topics/${encodeURIComponent(topicId)}/abort`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${NODE_CONTROL_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ userId }),
          },
        );
        const body = (await response.json()) as { aborted?: boolean; error?: string };
        if (!response.ok) throw new Error(body.error ?? `node returned HTTP ${response.status}`);
        return body.aborted === true;
      },
      submitTurn: async (input) => {
        const node = await waitForNodeDaemon(1_500);
        const response = await fetch(
          `${node.baseUrl}${NODE_CONTROL_BASE_PATH}/topics/${encodeURIComponent(input.topic.id)}/messages`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${NODE_CONTROL_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              userId: input.userId,
              text: input.text,
              sourceAdapter: input.sourceAdapter,
              visualTools: input.visualTools,
              fileDeliveryTools: input.fileDeliveryTools,
            }),
          },
        );
        const body = (await response.json()) as { error?: string; queryId?: string };
        if (!response.ok) throw new Error(body.error ?? `node returned HTTP ${response.status}`);
        return { queryId: body.queryId };
      },
    });
  } catch (error) {
    singleton.stop();
    throw error;
  }

  onShutdown("telegram-channel", 100, () => channel.stop());
  onShutdown("telegram-singleton", 90, () => singleton.stop());
  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  onShutdown("telegram-completed", -100, resolveCompleted);
  process.stdout.write(
    `negotium Telegram adapter connected to canonical node pid ${initialNode.info?.pid ?? "unknown"}\n`,
  );
  await completed;
}

if (import.meta.main) {
  runTelegramCli().catch((error) => {
    process.stderr.write(
      `negotium-telegram: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
