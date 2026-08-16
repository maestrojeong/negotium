import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixture = resolve(import.meta.dir, "../fixtures/multiprocess-runtime-worker.ts");
const roots: string[] = [];
const children: Bun.Subprocess[] = [];

class LineReader {
  readonly #reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
  };
  readonly #decoder = new TextDecoder();
  #buffer = "";
  readonly #label: string;
  readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;

  constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">, label: string) {
    this.#reader = child.stdout.getReader();
    this.#child = child;
    this.#label = label;
  }

  /**
   * Everything the child wrote to stderr, plus how it exited.
   *
   * The harness used to leave stderr piped and unread, so a worker that died
   * during startup surfaced only as `expect("").toBe("READY")` — no exit code,
   * no stack, nothing to act on. That is what made this suite's intermittent
   * failure undiagnosable for so long.
   */
  async #childDiagnostics(): Promise<string> {
    let stderr = "";
    try {
      stderr = (await new Response(this.#child.stderr).text()).trim();
    } catch {
      stderr = "(stderr unavailable)";
    }
    const exitCode = this.#child.exitCode;
    return [
      `worker "${this.#label}" produced no line`,
      `exit code: ${exitCode === null ? "still running" : exitCode}`,
      stderr ? `stderr:\n${stderr}` : "stderr: (empty)",
    ].join("\n");
  }

  async next(timeoutMs = 3_000): Promise<string> {
    const read = async (): Promise<string> => {
      while (true) {
        const newline = this.#buffer.indexOf("\n");
        if (newline >= 0) {
          const line = this.#buffer.slice(0, newline);
          this.#buffer = this.#buffer.slice(newline + 1);
          return line;
        }
        const { done, value } = await this.#reader.read();
        if (done) {
          // Stream closed with no complete line: the child exited early.
          // Returning the empty buffer here would assert `"" === "READY"` and
          // hide the reason, so surface what the child actually said.
          if (!this.#buffer) throw new Error(await this.#childDiagnostics());
          return this.#buffer;
        }
        if (value) this.#buffer += this.#decoder.decode(value, { stream: true });
      }
    };
    return Promise.race([
      read(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            void this.#childDiagnostics().then((detail) =>
              reject(
                new Error(`timed out after ${timeoutMs}ms waiting for child output\n${detail}`),
              ),
            ),
          timeoutMs,
        ),
      ),
    ]);
  }
}

function stateEnv(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "negotium-multiprocess-"));
  roots.push(root);
  return {
    ...process.env,
    LOG_LEVEL: "silent",
    NEGOTIUM_CRON: "0",
    // Neutralize an operator's pinned node port. `startDefaultNode` honors
    // NEGOTIUM_NODE_PORT for every `port: 0` caller, so inheriting it makes
    // both workers here ask for the same port — and this test exists to assert
    // they get different ones. An empty value reads as unset.
    NEGOTIUM_NODE_PORT: "",
    NEGOTIUM_STATE_DIR: root,
    NEGOTIUM_DATA_DIR: join(root, "data"),
    NEGOTIUM_LOG_DIR: join(root, "logs"),
    NEGOTIUM_RUN_DIR: join(root, "run"),
    SESSIONS_DB_PATH: join(root, "data", "sessions.db"),
  } as Record<string, string>;
}

function spawnWorker(
  env: Record<string, string>,
  ...args: string[]
): { child: Bun.Subprocess<"pipe", "pipe", "pipe">; lines: LineReader } {
  const child = Bun.spawn([process.execPath, fixture, ...args], {
    cwd: resolve(import.meta.dir, "../../../.."),
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return { child, lines: new LineReader(child, args.join(" ")) };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited.catch(() => {});
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cross-process runtime", () => {
  test("delivers a durable bus event between independent processes", async () => {
    const env = stateEnv();
    const topicId = `topic-${crypto.randomUUID()}`;
    const listener = spawnWorker(env, "bus-listen", topicId);
    expect(await listener.lines.next()).toBe("READY");

    const writer = spawnWorker(env, "bus-write", topicId);
    expect(await writer.lines.next()).toBe("WROTE");
    expect(await writer.child.exited).toBe(0);
    expect(await listener.lines.next()).toBe(`EVENT ${topicId}`);
    expect(await listener.child.exited).toBe(0);
  });

  test("returns a delivery acknowledgement between independent processes", async () => {
    const env = stateEnv();
    const topicId = `topic-${crypto.randomUUID()}`;
    const messageId = crypto.randomUUID();
    const listener = spawnWorker(env, "delivery-ack-listen", topicId, messageId);
    expect(await listener.lines.next()).toBe("READY");

    const writer = spawnWorker(env, "delivery-ack-write", topicId, messageId);
    expect(await writer.lines.next()).toBe("WROTE");
    expect(await writer.child.exited).toBe(0);
    expect(await listener.lines.next()).toBe('ACK {"ok":true}');
    expect(await listener.child.exited).toBe(0);
  });

  test("enforces singleton roles across processes", async () => {
    const env = stateEnv();
    const role = `adapter:test:${crypto.randomUUID()}`;
    const owner = spawnWorker(env, "singleton", role);
    expect(await owner.lines.next()).toBe("CLAIMED");

    const contender = spawnWorker(env, "singleton", role);
    expect(await contender.lines.next()).toBe("BUSY");
    expect(await contender.child.exited).toBe(0);
  });

  test("allows multiple independent node processes on ephemeral ports", async () => {
    const env = stateEnv();
    const first = spawnWorker(env, "node");
    const firstPort = Number.parseInt((await first.lines.next()).slice("READY ".length), 10);
    const second = spawnWorker(env, "node");
    const secondPort = Number.parseInt((await second.lines.next()).slice("READY ".length), 10);

    expect(firstPort).toBeGreaterThan(0);
    expect(secondPort).toBeGreaterThan(0);
    expect(secondPort).not.toBe(firstPort);
    first.child.stdin.write("stop\n");
    first.child.stdin.end();
    second.child.stdin.write("stop\n");
    second.child.stdin.end();
    expect(await first.child.exited).toBe(0);
    expect(await second.child.exited).toBe(0);
  });

  test("elects one session inbox worker and recovers after its process dies", async () => {
    const env = stateEnv();
    const owner = spawnWorker(env, "inbox-worker");
    expect(await owner.lines.next()).toBe(`READY ${owner.child.pid}`);

    const contender = spawnWorker(env, "inbox-worker");
    expect(await contender.lines.next()).toBe(`READY ${owner.child.pid}`);

    owner.child.kill();
    await owner.child.exited;
    expect(await contender.lines.next(3_000)).toBe(`OWNER ${contender.child.pid}`);

    contender.child.stdin.write("stop\n");
    contender.child.stdin.end();
    expect(await contender.child.exited).toBe(0);
  });

  test("serializes simultaneous durable user-turn merges without losing either message", async () => {
    const env = stateEnv();
    const topicId = `topic-${crypto.randomUUID()}`;
    const seed = spawnWorker(env, "turn-seed", topicId);
    expect(await seed.lines.next()).toBe("SEEDED");
    expect(await seed.child.exited).toBe(0);

    const first = spawnWorker(env, "turn-merge", topicId, "first");
    const second = spawnWorker(env, "turn-merge", topicId, "second");
    expect(await first.lines.next(10_000)).toBe("READY");
    expect(await second.lines.next(10_000)).toBe("READY");
    first.child.stdin.write("go\n");
    second.child.stdin.write("go\n");
    first.child.stdin.end();
    second.child.stdin.end();
    expect(await first.lines.next(10_000)).toBe("MERGED first");
    expect(await second.lines.next(10_000)).toBe("MERGED second");
    expect(await first.child.exited).toBe(0);
    expect(await second.child.exited).toBe(0);

    const reader = spawnWorker(env, "turn-read", topicId);
    const prompts = JSON.parse(await reader.lines.next()) as string[];
    expect(await reader.child.exited).toBe(0);
    expect(prompts[0]).toBe("base");
    expect(prompts.slice(1).sort()).toEqual(["first", "second"]);
  });
});
