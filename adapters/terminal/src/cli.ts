#!/usr/bin/env bun

function option(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

export function terminalOptionsFromArgs(args: string[]): {
  userId: string;
  preferredTopic?: string;
  defaultAgent?: "claude" | "codex" | "maestro";
  port: number;
  embedded: boolean;
  connect?: string;
} {
  const userId = option(args, "user")?.trim() || "local";
  const preferredTopic = option(args, "topic")?.trim() || undefined;
  const requestedAgent =
    option(args, "agent")?.trim() || process.env.TERMINAL_ADAPTER_AGENT?.trim();
  const defaultAgent =
    requestedAgent === "claude" || requestedAgent === "codex" || requestedAgent === "maestro"
      ? requestedAgent
      : undefined;
  const parsedPort = Number.parseInt(option(args, "port") ?? "0", 10);
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 0;
  const embedded = hasFlag(args, "embedded");
  const connect = option(args, "connect")?.trim().replace(/\/+$/, "") || undefined;
  return { userId, preferredTopic, defaultAgent, port, embedded, connect };
}

async function spawnNodeDaemon(port: number): Promise<void> {
  const entry = process.argv[1];
  if (!entry) throw new Error("cannot locate the Negotium CLI entrypoint");
  const { LOG_DIR } = await import("@negotium/core");
  const child = Bun.spawn({
    cmd: [process.execPath, entry, "__node-daemon", `--port=${port}`],
    detached: true,
    env: {
      ...process.env,
      LOG_LEVEL: process.env.NEGOTIUM_NODE_LOG_LEVEL?.trim() || "info",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: Bun.file(`${LOG_DIR}/node-daemon.log`),
  });
  child.unref();
}

async function runDaemonChild(args: string[]): Promise<void> {
  const parsed = Number.parseInt(option(args, "port") ?? "0", 10);
  const port = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  const { runNodeDaemon } = await import("@negotium/node");
  await runNodeDaemon({ port });
}

async function ensureLocalNode(
  port: number,
): Promise<import("@negotium/node").NodeDaemonConnection> {
  const { inspectNodeDaemon, waitForNodeDaemon } = await import("@negotium/node");
  const deadline = Date.now() + 15_000;
  let lastError = "node did not become ready";
  while (Date.now() < deadline) {
    const status = await inspectNodeDaemon();
    if (status.running) return waitForNodeDaemon(1_000);
    if (status.error) lastError = status.error;
    await spawnNodeDaemon(port);
    try {
      return await waitForNodeDaemon(1_500);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Negotium node failed to start: ${lastError}`);
}

/** Environment/argv wrapper shipped as the `negotium-terminal` executable. */
export async function runTerminalCli(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === "__node-daemon") {
    await runDaemonChild(args.slice(1));
    return;
  }

  // Pino binds its destination when core is first imported. Silence host logs
  // before the dynamic adapter import so stderr cannot corrupt the alt screen.
  process.env.LOG_LEVEL ??= "silent";

  const options = terminalOptionsFromArgs(args);
  if (options.embedded && options.connect) {
    throw new Error("--embedded and --connect cannot be used together");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("terminal-adapter requires an interactive TTY");
  }

  const { startTerminalAdapter } = await import("@/index");
  let client: import("@/client").NegotiumClient | undefined;
  if (!options.embedded) {
    const { NODE_CONTROL_TOKEN } = await import("@negotium/core");
    const { RemoteNegotiumClient } = await import("@/client");
    const connection = options.connect
      ? {
          baseUrl: options.connect,
          token: process.env.NEGOTIUM_CONTROL_TOKEN?.trim() || NODE_CONTROL_TOKEN,
        }
      : await ensureLocalNode(options.port);
    client = new RemoteNegotiumClient({ userId: options.userId, ...connection });
  }
  const adapter = startTerminalAdapter({ ...options, client });
  try {
    await adapter.completed;
  } catch (error) {
    await Promise.resolve(adapter.stop()).catch(() => {});
    throw error;
  }
}

if (import.meta.main) {
  runTerminalCli().catch((error) => {
    process.stderr.write(
      `negotium-terminal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
