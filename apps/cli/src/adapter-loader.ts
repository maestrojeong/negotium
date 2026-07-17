type TerminalCli = typeof import("@negotium/adapter-terminal/cli");
type TelegramCli = typeof import("@negotium/adapter-telegram/cli");
type OtiumCli = typeof import("@negotium/adapter-otium/cli");

const runningFromSource = import.meta.dir.endsWith("/src");

async function loadFromSource<T>(sourcePath: string): Promise<T> {
  // `bun apps/cli/src/main.ts` is a development entrypoint. Loading workspace
  // package exports there would silently use yesterday's dist build, so source
  // runs resolve the adapter source beside this package. A built/published CLI
  // continues to use normal package exports.
  return (await import(new URL(sourcePath, import.meta.url).href)) as T;
}

export function loadTerminalCli(): Promise<TerminalCli> {
  return runningFromSource
    ? loadFromSource("../../../adapters/terminal/src/cli.ts")
    : import("@negotium/adapter-terminal/cli");
}

export function loadTelegramCli(): Promise<TelegramCli> {
  return runningFromSource
    ? loadFromSource("../../../adapters/telegram/src/cli.ts")
    : import("@negotium/adapter-telegram/cli");
}

export function loadOtiumCli(): Promise<OtiumCli> {
  return runningFromSource
    ? loadFromSource("../../../adapters/otium/src/cli.ts")
    : import("@negotium/adapter-otium/cli");
}
