type TerminalCli = typeof import("@negotium/adapter-terminal/cli");
type TelegramCli = typeof import("@negotium/adapter-telegram/cli");
type OtiumCli = typeof import("@negotium/adapter-otium/cli");

const runningFromSource = import.meta.dir.endsWith("/src");

async function load<T>(packageName: string, sourcePath: string): Promise<T> {
  // `bun apps/cli/src/main.ts` is a development entrypoint. Loading workspace
  // package exports there would silently use yesterday's dist build, so source
  // runs resolve the adapter source beside this package. A built/published CLI
  // continues to use normal package exports.
  const specifier = runningFromSource ? new URL(sourcePath, import.meta.url).href : packageName;
  return (await import(specifier)) as T;
}

export function loadTerminalCli(): Promise<TerminalCli> {
  return load("@negotium/adapter-terminal/cli", "../../../adapters/terminal/src/cli.ts");
}

export function loadTelegramCli(): Promise<TelegramCli> {
  return load("@negotium/adapter-telegram/cli", "../../../adapters/telegram/src/cli.ts");
}

export function loadOtiumCli(): Promise<OtiumCli> {
  return load("@negotium/adapter-otium/cli", "../../../adapters/otium/src/cli.ts");
}
