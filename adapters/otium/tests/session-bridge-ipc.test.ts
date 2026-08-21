import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import type { PeerSessionBridge } from "@negotium/core";
import { peerSessionBridgeIpcEnv } from "@negotium/core/peer-session-bridge-ipc";
import { startPeerSessionBridgeIpc } from "@/session-bridge-ipc";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function forwardRequest(url: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${peerSessionBridgeIpcEnv()?.NEGOTIUM_PEER_SESSION_BRIDGE_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action: "forward",
      args: { action: "tell", toNode: "hub", toTopic: "topic", userId: "u1" },
    }),
  });
}

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

  test("queues requests beyond the active limit until a slot is available", async () => {
    const entered = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    const releaseThird = deferred<void>();
    let calls = 0;
    const bridge: PeerSessionBridge = {
      forward: async () => {
        calls += 1;
        if (calls === 2) entered.resolve();
        await [releaseFirst.promise, releaseSecond.promise, releaseThird.promise][calls - 1];
        return { ok: true };
      },
      sessions: async () => ({ ok: true }),
      reply: async () => true,
    };
    const ipc = startPeerSessionBridgeIpc(bridge, { maxInflight: 2, maxQueueDepth: 2 });
    try {
      const first = forwardRequest(ipc.url);
      const second = forwardRequest(ipc.url);
      await entered.promise;
      const third = forwardRequest(ipc.url);
      await Bun.sleep(10);
      expect(calls).toBe(2);

      releaseFirst.resolve();
      await Bun.sleep(10);
      expect(calls).toBe(3);
      releaseSecond.resolve();
      releaseThird.resolve();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect((await third).status).toBe(200);
    } finally {
      ipc.stop();
    }
  });

  test("rejects a request that exceeds its queue deadline with retry guidance", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const bridge: PeerSessionBridge = {
      forward: async () => {
        entered.resolve();
        await release.promise;
        return { ok: true };
      },
      sessions: async () => ({ ok: true }),
      reply: async () => true,
    };
    const ipc = startPeerSessionBridgeIpc(bridge, {
      maxInflight: 1,
      maxQueueDepth: 1,
      requestTimeoutMs: 40,
    });
    try {
      const first = forwardRequest(ipc.url);
      await entered.promise;
      const queued = await forwardRequest(ipc.url);
      expect(queued.status).toBe(503);
      expect(queued.headers.get("retry-after")).toBe("1");
      release.resolve();
      expect((await first).status).toBe(200);
    } finally {
      ipc.stop();
    }
  });

  test("keeps accounting bounded and releases every slot under concurrent load", async () => {
    let active = 0;
    let peakActive = 0;
    const bridge: PeerSessionBridge = {
      forward: async () => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await Bun.sleep(5);
        active -= 1;
        return { ok: true };
      },
      sessions: async () => ({ ok: true }),
      reply: async () => true,
    };
    const ipc = startPeerSessionBridgeIpc(bridge, { maxInflight: 2, maxQueueDepth: 4 });
    try {
      const responses = await Promise.all(Array.from({ length: 6 }, () => forwardRequest(ipc.url)));
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(peakActive).toBeLessThanOrEqual(2);
      expect((await forwardRequest(ipc.url)).status).toBe(200);
      expect(active).toBe(0);
    } finally {
      ipc.stop();
    }
  });
});
