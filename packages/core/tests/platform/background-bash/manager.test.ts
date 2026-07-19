import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  bgBashContextCapability,
  createBackgroundBashManager,
  ensureBgBash,
  killAllBgBash,
  makeBgBashKey,
} from "#platform/background-bash/manager";
import { SESSION_INBOX_DIR } from "#platform/config";
import { delay } from "#platform/delay";

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((entry) => entry.text ?? "")
    .join("\n");
}

afterEach(async () => {
  await killAllBgBash();
});

describe("shared background-bash runtime", () => {
  test("caller-owned managers isolate capability, port, and context state", async () => {
    const deletedA: string[] = [];
    const deletedB: string[] = [];
    const fakeProcess = () => {
      const process = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        killed: false,
      }) as EventEmitter & {
        exitCode: number | null;
        killed: boolean;
        kill: () => boolean;
      };
      process.kill = () => {
        process.killed = true;
        return true;
      };
      return process as unknown as ChildProcess;
    };
    const createFetch = (serverId: string, deleted: string[]) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "DELETE") deleted.push(url);
        return new Response(serverId, { status: 200 });
      }) as typeof fetch;
    const common = {
      basePort: 47_000,
      maxPort: 47_000,
      portPids: () => [],
      spawn: () => fakeProcess(),
      delay: async () => {},
    };
    const first = createBackgroundBashManager({
      ...common,
      capability: "a".repeat(64),
      serverId: "server-a",
      fetch: createFetch("server-a", deletedA),
    });
    const second = createBackgroundBashManager({
      ...common,
      capability: "b".repeat(64),
      serverId: "server-b",
      fetch: createFetch("server-b", deletedB),
    });

    expect(await first.ensure("alice", "topic")).toBe(47_000);
    expect(await second.ensure("alice", "topic")).toBe(47_000);
    expect(first.contextCapability("alice", "topic")).not.toBe(
      second.contextCapability("alice", "topic"),
    );
    first.clear("alice", "topic");
    expect(deletedA).toHaveLength(1);
    expect(deletedB).toHaveLength(0);
    await Promise.all([first.killAll(), second.killAll()]);
  });

  test("all topics reuse one server key", () => {
    expect(makeBgBashKey("alice", "topic-a")).toBe("runtime");
    expect(makeBgBashKey("bob", "topic-b")).toBe("runtime");
  });

  test("context capabilities isolate users and topics", () => {
    const current = bgBashContextCapability("alice", "topic-a");
    expect(current).toHaveLength(64);
    expect(bgBashContextCapability("alice", "topic-a")).toBe(current);
    expect(bgBashContextCapability("alice", "topic-b")).not.toBe(current);
    expect(bgBashContextCapability("bob", "topic-a")).not.toBe(current);
  });

  test("different topics reuse one healthy HTTP server", async () => {
    const first = await ensureBgBash("alice", "topic-a");
    const second = await ensureBgBash("bob", "topic-b");
    expect(second).toBe(first);
    expect((await fetch(`http://127.0.0.1:${first}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${first}/sse`)).status).toBe(403);
  });

  test("run returns an id, output is incremental, and completion is injected", async () => {
    const userId = `bg-bash-${randomUUID()}`;
    const topic = `topic-${randomUUID()}`;
    const inboxDir = join(SESSION_INBOX_DIR, userId);
    const inboxFile = join(inboxDir, `${topic}.jsonl`);
    const port = await ensureBgBash(userId, topic);
    const client = new Client({ name: "background-bash-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          "X-Background-Bash-User": userId,
          "X-Background-Bash-Topic": topic,
          "X-Background-Bash-Capability": bgBashContextCapability(userId, topic),
        },
      },
    });

    try {
      await client.connect(transport);
      const started = JSON.parse(
        toolText(
          await client.callTool({
            name: "background_bash_run",
            arguments: { command: "printf first; sleep 0.5; printf second" },
          }),
        ),
      ) as { bash_id: string; status: string };
      expect(started.bash_id).toMatch(/^bash_[0-9a-f]{12}$/);
      expect(started.status).toBe("started");

      let firstOutput = "";
      for (let attempt = 0; attempt < 20 && !firstOutput.includes("first"); attempt++) {
        await delay(25);
        firstOutput = toolText(
          await client.callTool({
            name: "background_bash_output",
            arguments: { bash_id: started.bash_id },
          }),
        );
      }
      expect(JSON.parse(firstOutput).stdout).toBe("first");

      let finalOutput = "";
      let exited = false;
      for (let attempt = 0; attempt < 40 && !exited; attempt++) {
        await delay(25);
        finalOutput = toolText(
          await client.callTool({
            name: "background_bash_output",
            arguments: { bash_id: started.bash_id },
          }),
        );
        exited = (JSON.parse(finalOutput) as { exited: boolean }).exited;
      }
      const final = JSON.parse(finalOutput) as {
        exited: boolean;
        exitCode: number | null;
        stdout: string;
      };
      expect(final).toMatchObject({ exited: true, exitCode: 0, stdout: "second" });

      for (let attempt = 0; attempt < 20 && !existsSync(inboxFile); attempt++) await delay(25);
      const completion = readFileSync(inboxFile, "utf-8");
      expect(completion).toContain(`[background_bash ${started.bash_id} 완료]`);
      expect(completion).toContain("firstsecond");
    } finally {
      await client.close();
      rmSync(inboxDir, { recursive: true, force: true });
    }
  }, 10_000);
});
