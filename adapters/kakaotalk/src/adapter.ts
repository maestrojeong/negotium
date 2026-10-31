/**
 * startKakaoTalkAdapter — wire the kakaotalk manager topic into this node.
 *
 * Unlike the telegram adapter, there is no client to own and no per-chat
 * routing: this registers two node-level extension points and returns.
 *   - `registerNodeRequestHandler` mounts the Open Builder webhook ahead of
 *     the built-in MCP/health routes (packages/core/src/platform/node-plugins.ts).
 *   - `registerRuntimeMcpServer` mounts `send_kakaotalk`, gated to only ever
 *     appear in the kakaotalk topic's own tool catalog (decision #1 — not a
 *     node-wide tool).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NegotiumAdapterHandle } from "@negotium/adapter-sdk";
import {
  buildStdioMcpServer,
  DATA_DIR,
  getTopic,
  logger,
  registerNodeRequestHandler,
  registerRuntimeMcpServer,
  unregisterNodeRequestHandler,
} from "@negotium/core";
import { openCallbackStore } from "@/callback-store";
import { type LocoBridgeHandle, startLocoBridge } from "@/loco/bridge";
import { startLocoControlServer } from "@/loco/control-server";
import type { KakaoTalkLocoConfig } from "@/loco/env-auth";
import { createLocoMessageHandler } from "@/loco/handler";
import { openLocoReplyStore } from "@/loco/reply-store";
import { ensureKakaoTalkTopic } from "@/topic";
import { createKakaoWebhookHandler } from "@/webhook";

const SOURCE_MCP_SERVER_FILE = fileURLToPath(new URL("./mcp-server.ts", import.meta.url));
const PACKAGED_MCP_SERVER_FILE = fileURLToPath(new URL("./mcp-server.js", import.meta.url));
const DEFAULT_LOCO_JAR = fileURLToPath(
  new URL("../loco-sidecar/build/libs/kakaotalk-loco-sidecar-1.0-SNAPSHOT.jar", import.meta.url),
);

export interface KakaoTalkAdapterOptions {
  /** negotium user the bot acts as; defaults to "local" (single-operator node). */
  userId?: string;
  /** Word that turns an inbound KakaoTalk message into an AI turn (decision #2). Default "lumi". */
  triggerWord?: string;
  /** Test/embedder hook; defaults to the real mcp-server.ts/.js next to this file. */
  mcpServerFile?: string;
  /** Callback-store db path override (tests). */
  callbackDbPath?: string;
  /**
   * `userRequest.user.id` values allowed to trigger a turn. Empty/absent
   * means allow all — see src/webhook.ts's `KakaoWebhookOptions.allowedUsers`
   * and src/env-auth.ts for why this is the only enforceable boundary
   * (Kakao's skill payload exposes no room/chat id, only the sender).
   */
  allowedUsers?: readonly string[];
  /**
   * LOCO (group/open-chat) transport config, already resolved from env via
   * src/loco/env-auth.ts's `parseKakaoTalkLocoAuthEnv` — undisabled unless
   * explicitly configured (see that module's doc comment for why this is
   * opt-in on top of the already-opt-in kakaotalk surface).
   */
  loco?: KakaoTalkLocoConfig;
  /** Path to the built loco-sidecar fat jar; defaults to the one next to this package. */
  locoJarPath?: string;
  /** Per-account LOCO session/device-registration state dir; defaults under DATA_DIR. */
  locoSessionDir?: string;
  /** LOCO reply-target store db path override (tests). */
  locoReplyDbPath?: string;
}

export interface KakaoTalkAdapterHandle extends NegotiumAdapterHandle<"kakaotalk"> {
  stop(): void;
}

const NODE_PLUGIN_NAME = "kakaotalk-webhook";
const MCP_SERVER_NAME = "kakaotalk";

export function startKakaoTalkAdapter(opts: KakaoTalkAdapterOptions = {}): KakaoTalkAdapterHandle {
  const userId = opts.userId ?? "local";
  const triggerWord = opts.triggerWord ?? "lumi";

  const topic = ensureKakaoTalkTopic(userId);
  const callbackStore = openCallbackStore(opts.callbackDbPath);

  const webhookHandler = createKakaoWebhookHandler({
    // Re-read on every request instead of closing over the initial topic:
    // title/other fields can change, but the id is stable for this node's lifetime.
    topic: () => getTopic(topic.id) ?? topic,
    userId,
    triggerWord,
    callbackStore,
    allowedUsers: opts.allowedUsers,
  });
  registerNodeRequestHandler(NODE_PLUGIN_NAME, webhookHandler);

  // LOCO transport: a persistent logged-in session (not a per-request
  // webhook), so it lives for this process's whole lifetime, same as the
  // webhook registration above but started conditionally.
  let locoBridge: LocoBridgeHandle | null = null;
  let locoControlServer: ReturnType<typeof startLocoControlServer> | null = null;
  const locoReplyStore = openLocoReplyStore(opts.locoReplyDbPath);
  if (opts.loco?.enabled) {
    const loco = opts.loco;
    const locoMessageHandler = createLocoMessageHandler({
      topic: () => getTopic(topic.id) ?? topic,
      userId,
      triggerWord,
      config: loco,
      replyStore: locoReplyStore,
    });
    locoControlServer = startLocoControlServer(() => locoBridge);
    locoBridge = startLocoBridge({
      email: loco.credentials.email,
      password: loco.credentials.password,
      deviceUuid: loco.credentials.deviceUuid,
      ...(loco.credentials.deviceName ? { deviceName: loco.credentials.deviceName } : {}),
      sessionDir: opts.locoSessionDir ?? join(DATA_DIR, "adapter-kakaotalk-loco-session"),
      jarPath: opts.locoJarPath ?? DEFAULT_LOCO_JAR,
      onMessage: locoMessageHandler,
      onNeedsRegistration(passcode, remainingSeconds) {
        // One-time setup step: the operator must enter this code in the
        // KakaoTalk app on their ALREADY-TRUSTED device within the window.
        // There is no further negotium-side action to take here other than
        // surfacing it — module.ts/the operator-facing docs point at the
        // node log for this.
        logger.warn(
          { passcode, remainingSeconds },
          "kakaotalk adapter: LOCO device needs one-time approval — open KakaoTalk on your phone and enter this code",
        );
      },
      onReady(userId) {
        logger.info({ locoUserId: userId }, "kakaotalk adapter: LOCO session connected");
      },
      onError(message, fatal) {
        logger[fatal ? "error" : "warn"]({ fatal }, `kakaotalk adapter: LOCO bridge — ${message}`);
      },
      onDisconnected() {
        logger.warn("kakaotalk adapter: LOCO session disconnected");
      },
    });
  }

  const mcpServerFile =
    opts.mcpServerFile ??
    (existsSync(SOURCE_MCP_SERVER_FILE) ? SOURCE_MCP_SERVER_FILE : PACKAGED_MCP_SERVER_FILE);
  const unregisterMcp = registerRuntimeMcpServer(MCP_SERVER_NAME, {
    scopes: ["manager"],
    build({ topicId, agent }) {
      // Decision #1: send_kakaotalk is visible ONLY in the kakaotalk topic
      // itself, never node-wide.
      if (!topicId || getTopic(topicId)?.surface !== "kakaotalk") return null;
      const mcpArgs = [`--topic-id=${topicId}`];
      if (locoControlServer) {
        mcpArgs.push(
          `--loco-control-url=${locoControlServer.url}`,
          `--loco-control-token=${locoControlServer.token}`,
        );
      }
      return buildStdioMcpServer(agent, mcpServerFile, mcpArgs);
    },
  });

  let stopped = false;
  return {
    name: "kakaotalk",
    stop() {
      if (stopped) return;
      stopped = true;
      unregisterNodeRequestHandler(NODE_PLUGIN_NAME);
      unregisterMcp();
      callbackStore.close();
      locoReplyStore.close();
      locoBridge?.stop();
      locoControlServer?.stop();
    },
  };
}
