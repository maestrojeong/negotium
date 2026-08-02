import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createCodexAppServerForker } from "#agents/codex-app-server";
import { NEGOTIUM_VERSION } from "#version";

function fakeServer(respond: (message: Record<string, unknown>, stdout: PassThrough) => void): {
  child: ChildProcessWithoutNullStreams;
  requests: Record<string, unknown>[];
} {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).trim().split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        requests.push(message);
        respond(message, stdout);
      }
      callback();
    },
  });
  const child = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  return { child, requests };
}

describe("Codex app-server thread fork", () => {
  test("initializes and returns the native fork rollout", async () => {
    const parentThreadId = "019c0000-0000-7000-8000-000000000001";
    const forkThreadId = "019c0000-0000-7000-8000-000000000002";
    const rolloutPath = `/tmp/rollout-${forkThreadId}.jsonl`;
    const server = fakeServer((message, stdout) => {
      if (message.id === 1) {
        stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      }
      if (message.id === 2) {
        stdout.write(`${JSON.stringify({ id: 2, result: { thread: { id: forkThreadId } } })}\n`);
      }
    });
    const fork = createCodexAppServerForker({
      spawnServer: () => server.child,
      findRolloutPath: (threadId) => (threadId === forkThreadId ? rolloutPath : undefined),
      timeoutMs: 1_000,
    });

    await expect(fork(parentThreadId)).resolves.toEqual({
      forkId: forkThreadId,
      rolloutPath,
    });
    expect(server.requests).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "negotium", version: NEGOTIUM_VERSION },
        },
      },
      { method: "initialized" },
      { id: 2, method: "thread/fork", params: { threadId: parentThreadId } },
    ]);
  });

  test("rejects a successful response whose rollout is missing", async () => {
    const server = fakeServer((message, stdout) => {
      if (message.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      if (message.id === 2) {
        stdout.write(
          `${JSON.stringify({
            id: 2,
            result: { thread: { id: "019c0000-0000-7000-8000-000000000003" } },
          })}\n`,
        );
      }
    });
    const fork = createCodexAppServerForker({
      spawnServer: () => server.child,
      findRolloutPath: () => undefined,
      timeoutMs: 1_000,
    });

    await expect(fork("019c0000-0000-7000-8000-000000000001")).rejects.toThrow(
      "rollout was not found",
    );
  });
});
