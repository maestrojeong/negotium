/**
 * Loopback-only control endpoint so `send_kakaotalk`'s per-turn subprocess
 * (mcp-server.ts) can reach the live LOCO session, which only exists in
 * THIS process's memory (the Java daemon's stdin pipe is held here, not
 * shared with any subprocess the MCP host spawns).
 *
 * Bound to 127.0.0.1 and gated by a random, process-lifetime capability
 * token minted at startup and passed to the subprocess as a CLI arg — never
 * written to disk, never logged. This mirrors the existing background-bash
 * MCP server's pattern (a loopback HTTP listener + a bearer capability
 * header) rather than the public Open Builder webhook's pattern, since this
 * route must NEVER be reachable from whatever public tunnel exposes that
 * webhook: an unauthenticated version of this endpoint would let anyone on
 * the internet make the bot send arbitrary KakaoTalk messages.
 */

import { randomBytes } from "node:crypto";
import { logger } from "@negotium/core";
import type { LocoBridgeHandle } from "@/loco/bridge";

export interface LocoControlServer {
  /** `http://127.0.0.1:<port>` — pass to the MCP subprocess as --loco-control-url. */
  url: string;
  /** Bearer token the subprocess must present — pass as --loco-control-token. */
  token: string;
  stop(): void;
}

export function startLocoControlServer(
  getBridge: () => LocoBridgeHandle | null,
): LocoControlServer {
  const token = randomBytes(24).toString("hex");

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/send" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${token}`) {
        return new Response("unauthorized", { status: 401 });
      }

      const bridge = getBridge();
      if (!bridge) {
        return Response.json(
          { ok: false, error: "loco session is not connected" },
          { status: 503 },
        );
      }

      let body: { chatId?: number; text?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.chatId !== "number" || typeof body.text !== "string" || !body.text) {
        return Response.json(
          { ok: false, error: "chatId (number) and text (string) are required" },
          {
            status: 400,
          },
        );
      }

      try {
        const ok = await bridge.send(body.chatId, body.text);
        return Response.json({ ok });
      } catch (error) {
        logger.warn({ err: error }, "kakaotalk loco control server: send failed");
        return Response.json({ ok: false, error: "send failed" }, { status: 500 });
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    stop() {
      server.stop(true);
    },
  };
}
