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

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
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
        if (done) return this.#buffer;
        if (value) this.#buffer += this.#decoder.decode(value, { stream: true });
      }
    };
    return Promise.race([
      read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for child output")), timeoutMs),
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
  return { child, lines: new LineReader(child.stdout) };
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
});
