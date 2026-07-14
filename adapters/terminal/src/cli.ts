#!/usr/bin/env bun

function option(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export function terminalOptionsFromArgs(args: string[]): {
  userId: string;
  preferredTopic?: string;
  defaultAgent?: "claude" | "codex" | "maestro";
  port: number;
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
  return { userId, preferredTopic, defaultAgent, port };
}

/** Environment/argv wrapper shipped as the `negotium-terminal` executable. */
export async function runTerminalCli(args = process.argv.slice(2)): Promise<void> {
  // Pino binds its destination when core is first imported. Silence host logs
  // before the dynamic adapter import so stderr cannot corrupt the alt screen.
  process.env.LOG_LEVEL ??= "silent";

  const options = terminalOptionsFromArgs(args);

  const { startTerminalAdapter } = await import("@/index");
  const adapter = startTerminalAdapter(options);
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
