/**
 * TypeScript side of the stdio bridge to the vendored LOCO sidecar
 * (loco-sidecar/, a Java daemon — see that package's Daemon.java for the
 * exact newline-delimited JSON wire contract this file speaks both ends of).
 *
 * This is what makes decision A (one kakaotalk manager topic, now fed by
 * TWO transports — the Open Builder webhook for 1:1 channel chat, and this
 * LOCO session for group/open-chat rooms) possible: group-chat messages
 * have nowhere else to come from, since Kakao's official Open Builder
 * webhook has no open-chat/group-chat delivery path at all.
 *
 * Runs the real logged-in account's session for the lifetime of this node
 * process — not a per-request subprocess like mcp-server.ts. `send()` is
 * reached from mcp-server.ts's subprocess through the local control server
 * in control-server.ts, since the live Java process (and its stdin pipe)
 * only exists in THIS process's memory.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { logger } from "@negotium/core";

export interface LocoMessageEvent {
  chatId: number;
  /** "OM" open-chat group, "OD" open-chat 1:1, "MultiChat" group, "DirectChat" 1:1. */
  roomType: "OM" | "OD" | "MultiChat" | "DirectChat";
  roomName: string;
  logId: number;
  authorId: number;
  authorName: string;
  /** 1 owner, 2 member, 4 admin, 8 bot (MemberType.java). */
  memberType: number;
  text: string;
  sendAt: number;
}

export interface LocoBridgeOptions {
  email: string;
  password: string;
  deviceName?: string;
  deviceUuid: string;
  /** Per-account session/device-registration state (TalkClient persists login + sync tokens here). */
  sessionDir: string;
  /** Path to the built loco-sidecar fat jar. */
  jarPath: string;
  /** Override for tests; defaults to "java" on PATH. */
  javaBin?: string;
  onMessage: (event: LocoMessageEvent) => void;
  onNeedsRegistration: (passcode: string, remainingSeconds: number) => void;
  onReady: (userId: number) => void;
  /** Non-fatal errors (stderr chatter, a single bad command) vs. fatal (process gives up and will exit). */
  onError: (message: string, fatal: boolean) => void;
  onDisconnected: () => void;
}

export interface LocoBridgeHandle {
  /** Resolves `true` once the daemon's send_result event confirms delivery, `false` on failure or timeout. */
  send(chatId: number, text: string): Promise<boolean>;
  stop(): void;
}

const SEND_TIMEOUT_MS = 10_000;

interface LocoEvent {
  type: string;
  [key: string]: unknown;
}

export function startLocoBridge(opts: LocoBridgeOptions): LocoBridgeHandle {
  mkdirSync(opts.sessionDir, { recursive: true });

  const child: ChildProcessWithoutNullStreams = spawn(
    opts.javaBin ?? "java",
    ["-jar", opts.jarPath],
    {
      cwd: opts.sessionDir,
      env: {
        ...process.env,
        NEGOTIUM_KAKAO_LOCO_EMAIL: opts.email,
        NEGOTIUM_KAKAO_LOCO_PASSWORD: opts.password,
        NEGOTIUM_KAKAO_LOCO_DEVICE_NAME: opts.deviceName ?? "SM-X930",
        NEGOTIUM_KAKAO_LOCO_DEVICE_UUID: opts.deviceUuid,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const pending = new Map<string, (ok: boolean) => void>();

  const stdoutLines = createInterface({ input: child.stdout });
  stdoutLines.on("line", (line) => {
    if (!line.trim()) return;
    let event: LocoEvent;
    try {
      event = JSON.parse(line) as LocoEvent;
    } catch {
      logger.warn({ line }, "kakaotalk loco bridge: unparseable line from sidecar stdout");
      return;
    }
    switch (event.type) {
      case "ready":
        opts.onReady(event.userId as number);
        break;
      case "needs_registration":
        opts.onNeedsRegistration(event.passcode as string, event.remainingSeconds as number);
        break;
      case "message":
        opts.onMessage(event as unknown as LocoMessageEvent);
        break;
      case "error":
        opts.onError(event.message as string, Boolean(event.fatal));
        break;
      case "disconnected":
        opts.onDisconnected();
        break;
      case "send_result": {
        const requestId = event.requestId as string;
        const resolve = pending.get(requestId);
        if (resolve) {
          pending.delete(requestId);
          resolve(Boolean(event.ok));
        }
        break;
      }
      // member_joined / member_left: not consumed yet, intentionally ignored.
      default:
        break;
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    opts.onError(`sidecar stderr: ${chunk.toString("utf8").trim()}`, false);
  });
  child.on("exit", (code, signal) => {
    logger.warn({ code, signal }, "kakaotalk loco bridge: sidecar process exited");
    opts.onDisconnected();
  });

  function send(chatId: number, text: string): Promise<boolean> {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const timeout = setTimeout(() => {
        if (pending.delete(requestId)) resolve(false);
      }, SEND_TIMEOUT_MS);
      pending.set(requestId, (ok) => {
        clearTimeout(timeout);
        resolve(ok);
      });
      child.stdin.write(`${JSON.stringify({ type: "send", requestId, chatId, text })}\n`);
    });
  }

  function stop(): void {
    stdoutLines.close();
    for (const resolve of pending.values()) resolve(false);
    pending.clear();
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    child.kill();
  }

  return { send, stop };
}
