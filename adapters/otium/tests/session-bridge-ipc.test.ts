import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import type { PeerSessionBridge } from "@negotium/core";
import { peerSessionBridgeIpcEnv } from "@negotium/core/peer-session-bridge-ipc";
import { startPeerSessionBridgeIpc } from "@/session-bridge-ipc";

describe("peer session bridge IPC", () => {
  test("forwards calls from a separate MCP-like process over authenticated loopback", async () => {
    const replies: string[] = [];
    const bridge: PeerSessionBridge = {
      forward: async (args) =>
        args.toNode === "hub" ? { ok: true } : { ok: false, error: "unknown node" },
      sessions: async (userId) => ({
        ok: true,
        nodes: [
          {
            node: "hub",
            sessions: [{ name: `${userId}/topic`, agent: "codex", hasSession: true }],
          },
        ],
      }),
      reply: async (_route, _sourceTitle, replyText) => {
        replies.push(replyText);
        return true;
      },
    };
    const ipc = startPeerSessionBridgeIpc(bridge);
    try {
      expect(process.env.NEGOTIUM_PEER_SESSION_BRIDGE_TOKEN).toBeUndefined();
      expect((await fetch(ipc.url, { method: "POST", body: "{}" })).status).toBe(401);
      const peerModule = pathToFileURL(
        `${import.meta.dir}/../../../packages/core/src/mcp/session-comm/peer-forward.ts`,
      ).href;
      const script = `
        const peer = await import(${JSON.stringify(peerModule)});
        const forward = await peer.forwardToPeer({action:"tell",toNode:"hub",toTopic:"topic",userId:"u1"});
        const sessions = await peer.peerSessionsForUser("u1");
        const reply = await peer.deliverPeerReply({nodeName:"hub",nodeCellId:"c1",topicId:"t1",userId:"u1",requestId:"r1"},"source","done","reply");
        console.log(JSON.stringify({forward,sessions,reply}));
      `;
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, ...peerSessionBridgeIpcEnv() },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        forward: { ok: true },
        sessions: {
          ok: true,
          nodes: [
            {
              node: "hub",
              sessions: [{ name: "u1/topic", agent: "codex", hasSession: true }],
            },
          ],
        },
        reply: true,
      });
      expect(replies).toEqual(["done"]);
    } finally {
      ipc.stop();
    }
  });
});
