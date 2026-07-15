type AdapterName = "terminal" | "telegram" | "otium";

import { loadOtiumCli, loadTelegramCli, loadTerminalCli } from "@/adapter-loader";

function selectedAdapter(args: string[]): AdapterName {
  const withArg = args.find((arg) => arg.startsWith("--with="))?.slice("--with=".length);
  const requested = [
    ...(withArg?.split(",") ?? []),
    ...args.filter((arg) => !arg.startsWith("--")),
  ].filter(Boolean);

  if (requested.includes("all") || requested.length > 1) {
    throw new Error(
      "adapters run as independent processes; start terminal, telegram, and otium in separate shells",
    );
  }

  const requestedName = requested[0];
  if (requestedName === "terminal" || requestedName === "telegram" || requestedName === "otium") {
    return requestedName;
  }
  if (requestedName) throw new Error(`unknown adapter: ${requestedName}`);

  if (process.stdin.isTTY && process.stdout.isTTY) return "terminal";
  if (process.env.TELEGRAM_BOT_TOKEN?.trim()) return "telegram";
  if (
    process.env.OTIUM_CENTRAL_URL?.trim() ||
    process.env.OTIUM_CELL_ID?.trim() ||
    process.env.OTIUM_CELL_SECRET?.trim()
  ) {
    return "otium";
  }
  throw new Error("no adapter selected; pass terminal, telegram, or otium");
}

function terminalArgs(args: string[]): string[] {
  return args.filter((arg) => arg !== "terminal" && !arg.startsWith("--with="));
}

/**
 * Start one channel in this process. Terminal is a short-lived client of the
 * state directory's long-lived node; the other adapters retain their own host
 * lifecycle until they migrate to the same control boundary.
 */
export async function adaptersCommand(args: string[]): Promise<void> {
  const adapter = selectedAdapter(args);
  switch (adapter) {
    case "terminal": {
      const { runTerminalCli } = await loadTerminalCli();
      await runTerminalCli(terminalArgs(args));
      break;
    }
    case "telegram": {
      const { runTelegramCli } = await loadTelegramCli();
      await runTelegramCli();
      break;
    }
    case "otium": {
      const { runOtiumCli } = await loadOtiumCli();
      await runOtiumCli(["serve"]);
      break;
    }
  }
}
