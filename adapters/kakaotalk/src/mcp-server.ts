#!/usr/bin/env node
/**
 * `send_kakaotalk` — the only way an AI turn actually sends a KakaoTalk
 * message (decision #1: no automatic relay like the telegram adapter).
 *
 * Runs as a short-lived stdio subprocess per turn (standard pattern, see
 * packages/module-cron/src/mcp-server.ts) so it cannot share in-memory state
 * with whichever transport received the trigger — the Open Builder webhook
 * handler, or the LOCO bridge's live session — both of which live in the
 * main node process. The handoff is SQLite (src/callback-store.ts for Open
 * Builder) plus, for LOCO, a loopback control server (src/loco/control-server.ts)
 * since actually SENDING over LOCO requires writing to a live process's
 * stdin pipe that only the main process holds.
 *
 * Tries Open Builder's callback store first, then the LOCO reply-target
 * store — exactly one will have a pending entry for any given turn, since a
 * turn is only ever started by one transport's trigger.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openCallbackStore } from "@/callback-store";
import { postKakaoCallback } from "@/kakao-api";
import { openLocoReplyStore } from "@/loco/reply-store";

const args = process.argv.slice(2);
const arg = (name: string) =>
  args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
const topicId = arg("topic-id");
const locoControlUrl = arg("loco-control-url");
const locoControlToken = arg("loco-control-token");

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(error: unknown) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
    ],
  };
}

const server = new McpServer({ name: "negotium-kakaotalk", version: "0.1.0" });

server.tool(
  "send_kakaotalk",
  "Send the reply to the KakaoTalk message that triggered this turn. Only works once per trigger, " +
    "and only within the short window Kakao gives a channel bot to answer (~1 minute) — there is no " +
    "general-purpose 'message anyone at any time' endpoint for a channel chatbot, so this will fail " +
    "if called outside an active trigger window.",
  {
    message: z.string().min(1).describe("Reply text to send back to the KakaoTalk chat."),
  },
  async ({ message }) => {
    if (!topicId) return fail("no --topic-id was passed to this server; cannot resolve a callback");

    const callbackStore = openCallbackStore();
    try {
      const pending = callbackStore.takeLatest(topicId);
      if (pending) {
        await postKakaoCallback(pending.callbackUrl, message);
        return ok("sent");
      }
    } catch (error) {
      return fail(error);
    } finally {
      callbackStore.close();
    }

    const replyStore = openLocoReplyStore();
    try {
      const pending = replyStore.takeLatest(topicId);
      if (!pending) {
        return fail(
          "no active KakaoTalk reply target for this topic — this can only reply within the current " +
            "trigger's turn, once per trigger (whether the trigger came in over the Open Builder channel " +
            "or a LOCO group/open-chat room).",
        );
      }
      if (!locoControlUrl || !locoControlToken) {
        return fail(
          "a LOCO reply target is pending but this server was not given --loco-control-url/--loco-control-token; " +
            "the kakaotalk adapter's LOCO bridge is not running",
        );
      }
      const res = await fetch(`${locoControlUrl}/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${locoControlToken}`,
        },
        body: JSON.stringify({ chatId: pending.chatId, text: message }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) {
        return fail(body?.error ?? `loco send failed (HTTP ${res.status})`);
      }
      return ok("sent");
    } catch (error) {
      return fail(error);
    } finally {
      replyStore.close();
    }
  },
);

await server.connect(new StdioServerTransport());
