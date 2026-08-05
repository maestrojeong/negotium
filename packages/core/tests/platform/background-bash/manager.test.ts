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
import { sessionInboxPath } from "#query/session-inbox-path";
import { flushBashrsCompletions } from "#runtime/bashrs-completions";

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((entry) => entry.text ?? "")
    .join("\n");
}

afterEach(async () => {
  await killAllBgBash();
});

// Split deliberately. The mocked cases below assert manager bookkeeping with a
// fake spawn/fetch and must run everywhere, including CI; only the cases that
// spawn a real bash-rs are skipped when no binary is installed, since there is
// no TS stand-in to fall back to. Wrapping both in one skipIf meant CI proved
// nothing about this file at all.
const hasBashRs = Boolean(process.env.NEGOTIUM_BASH_RS_BIN);

describe("background-bash manager bookkeeping", () => {
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
        return new Response(JSON.stringify({ instance_id: serverId }), { status: 200 });
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
});

describe.skipIf(!hasBashRs)("shared background-bash runtime", () => {
  test("different topics reuse one healthy HTTP server", async () => {
    const first = await ensureBgBash("alice", "topic-a");
    const second = await ensureBgBash("bob", "topic-b");
    expect(second).toBe(first);
    expect((await fetch(`http://127.0.0.1:${first}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${first}/sse`)).status).toBe(401);
  });

  test("run returns an id, output is incremental, and completion is injected", async () => {
    const userId = `bg-bash-${randomUUID()}`;
    const topic = `topic-${randomUUID()}`;
    const inboxDir = join(SESSION_INBOX_DIR, userId);
    // Completion is delivered through the canonical topic-id-keyed inbox file
    // so the session-inbox worker can resolve it back to a topic id.
    const inboxFile = sessionInboxPath(userId, topic);
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
      const runTool = (await client.listTools()).tools.find(
        (tool) => tool.name === "background_bash_run",
      );
      expect(runTool?.description).toContain("longer than about 2 minutes");
      expect(runTool?.description).toContain("ordinary builds, tests");
      expect(runTool?.description).toContain("do not use this merely to avoid waiting");
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

      let observedStdout = "";
      for (let attempt = 0; attempt < 20 && !observedStdout.includes("first"); attempt++) {
        await delay(25);
        const output = JSON.parse(
          toolText(
            await client.callTool({
              name: "background_bash_output",
              arguments: { bash_id: started.bash_id },
            }),
          ),
        ) as { stdout: string };
        observedStdout += output.stdout;
      }
      expect(observedStdout).toContain("first");

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
        const output = JSON.parse(finalOutput) as { exited: boolean; stdout: string };
        observedStdout += output.stdout;
        exited = output.exited;
      }
      const final = JSON.parse(finalOutput) as {
        exited: boolean;
        exitCode: number | null;
      };
      expect(final).toMatchObject({ exited: true, exitCode: 0 });
      expect(observedStdout).toBe("firstsecond");

      const completion = await waitForInbox(inboxFile);
      expect(completion).toContain(`[background_bash ${started.bash_id} finished]`);
      expect(completion).toContain("firstsecond");
    } finally {
      await client.close();
      rmSync(inboxDir, { recursive: true, force: true });
    }
  }, 10_000);

  async function connectWatchClient(userId: string, topic: string) {
    const port = await ensureBgBash(userId, topic);
    const client = new Client({ name: "background-bash-watch-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          "X-Background-Bash-User": userId,
          "X-Background-Bash-Topic": topic,
          "X-Background-Bash-Capability": bgBashContextCapability(userId, topic),
        },
      },
    });
    await client.connect(transport);
    return client;
  }

  // Generous budget: the timeout-watch test alone needs its own 1s
  // `timeout_seconds` to actually elapse before the file can appear, and a
  // loaded CI runner adds real slack on top of that.
  // bash-rs only writes result.json; negotium's watcher is what turns that into
  // a session-inbox tell, so drive it explicitly instead of running the worker.
  async function waitForInbox(inboxFile: string): Promise<string> {
    for (let attempt = 0; attempt < 200 && !existsSync(inboxFile); attempt++) {
      await flushBashrsCompletions();
      if (existsSync(inboxFile)) break;
      await delay(25);
    }
    return existsSync(inboxFile) ? readFileSync(inboxFile, "utf-8") : "";
  }

  test("watch injects exactly one turn on match and stops the process", async () => {
    const userId = `bg-bash-watch-${randomUUID()}`;
    const topic = `topic-${randomUUID()}`;
    const inboxDir = join(SESSION_INBOX_DIR, userId);
    const inboxFile = sessionInboxPath(userId, topic);
    const client = await connectWatchClient(userId, topic);
    try {
      const watchTool = (await client.listTools()).tools.find(
        (tool) => tool.name === "background_bash_watch",
      );
      expect(watchTool?.description).toContain("one-shot");

      const started = JSON.parse(
        toolText(
          await client.callTool({
            name: "background_bash_watch",
            arguments: {
              command:
                'printf "line one\\n"; sleep 0.1; printf "target-ready\\n"; sleep 5; echo NEVER_RUNS',
              match: "^target-ready$",
            },
          }),
        ),
      ) as { bash_id: string; status: string };
      expect(started.bash_id).toMatch(/^bash_[0-9a-f]{12}$/);
      expect(started.status).toBe("watching");

      const completion = await waitForInbox(inboxFile);
      expect(completion).toContain(`[background_bash_watch ${started.bash_id} matched]`);
      expect(completion).toContain("matched line: target-ready");
      // Only one injected turn: the process must have been killed before the
      // `sleep 5` elapsed, so NEVER_RUNS's *output* (not the echoed command
      // string, which always contains the literal command text) never
      // appears in the captured stdout section.
      const stdoutSection = (JSON.parse(completion.trim()) as { message: string }).message.split(
        "stdout:\n",
      )[1];
      expect(stdoutSection).not.toContain("NEVER_RUNS");
      const injectedEntries = completion
        .trim()
        .split("\n")
        .filter((line) => line.includes(started.bash_id));
      expect(injectedEntries).toHaveLength(1);
    } finally {
      await client.close();
      rmSync(inboxDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("watch injects a timeout turn when nothing matches in time", async () => {
    const userId = `bg-bash-watch-timeout-${randomUUID()}`;
    const topic = `topic-${randomUUID()}`;
    const inboxDir = join(SESSION_INBOX_DIR, userId);
    const inboxFile = sessionInboxPath(userId, topic);
    const client = await connectWatchClient(userId, topic);
    try {
      const started = JSON.parse(
        toolText(
          await client.callTool({
            name: "background_bash_watch",
            arguments: {
              command: "sleep 5",
              match: "this-never-appears",
              timeout_seconds: 1,
            },
          }),
        ),
      ) as { bash_id: string };

      const completion = await waitForInbox(inboxFile);
      expect(completion).toContain(
        `[background_bash_watch ${started.bash_id} timed out without a match]`,
      );
    } finally {
      await client.close();
      rmSync(inboxDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("watch injects an exit turn when the command finishes before matching", async () => {
    const userId = `bg-bash-watch-exit-${randomUUID()}`;
    const topic = `topic-${randomUUID()}`;
    const inboxDir = join(SESSION_INBOX_DIR, userId);
    const inboxFile = sessionInboxPath(userId, topic);
    const client = await connectWatchClient(userId, topic);
    try {
      const started = JSON.parse(
        toolText(
          await client.callTool({
            name: "background_bash_watch",
            arguments: {
              command: 'printf "nothing interesting here\\n"',
              match: "this-never-appears",
            },
          }),
        ),
      ) as { bash_id: string };

      const completion = await waitForInbox(inboxFile);
      expect(completion).toContain(
        `[background_bash_watch ${started.bash_id} exited before matching]`,
      );
      expect(completion).toContain("nothing interesting here");
    } finally {
      await client.close();
      rmSync(inboxDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("watch rejects an invalid regex", async () => {
    const userId = `bg-bash-watch-badregex-${randomUUID()}`;
    const topic = `topic-${randomUUID()}`;
    const client = await connectWatchClient(userId, topic);
    try {
      const result = await client.callTool({
        name: "background_bash_watch",
        arguments: { command: "true", match: "(unclosed" },
      });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain("invalid regex in `match`");
    } finally {
      await client.close();
    }
  }, 10_000);
});
