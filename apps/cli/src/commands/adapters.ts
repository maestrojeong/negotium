import type { NegotiumAdapterHandle } from "@negotium/adapter-sdk";
import {
  onShutdown,
  registerNodeRequestHandler,
  unregisterNodeRequestHandler,
} from "@negotium/core";
import { startDefaultNode } from "@negotium/node";

type AdapterName = "terminal" | "telegram" | "otium";

function selectedAdapters(args: string[]): Set<AdapterName> {
  const withArg = args.find((arg) => arg.startsWith("--with="))?.slice("--with=".length);
  const requested = [
    ...(withArg?.split(",") ?? []),
    ...args.filter((arg) => !arg.startsWith("--")),
  ].filter(Boolean);
  if (requested.includes("all")) return new Set(["terminal", "telegram", "otium"]);
  if (requested.length === 0) {
    const detected = new Set<AdapterName>();
    if (process.stdin.isTTY && process.stdout.isTTY) detected.add("terminal");
    if (process.env.TELEGRAM_BOT_TOKEN?.trim()) detected.add("telegram");
    if (
      process.env.OTIUM_CENTRAL_URL?.trim() ||
      process.env.OTIUM_CELL_ID?.trim() ||
      process.env.OTIUM_CELL_SECRET?.trim()
    ) {
      detected.add("otium");
    }
    return detected;
  }
  const selected = new Set<AdapterName>();
  for (const name of requested) {
    if (name !== "terminal" && name !== "telegram" && name !== "otium") {
      throw new Error(`unknown adapter: ${name}`);
    }
    selected.add(name);
  }
  return selected;
}

/** Start one node and mount any combination of first-party channel adapters. */
export async function adaptersCommand(args: string[]): Promise<void> {
  const selected = selectedAdapters(args);
  if (selected.size === 0) {
    throw new Error(
      "no adapter selected; pass terminal, telegram, otium, all, or configure channel env",
    );
  }

  const node = await startDefaultNode();
  let terminalCompleted: Promise<void> | undefined;
  let stopped = false;
  const mount = <T extends NegotiumAdapterHandle>(handle: T): T => {
    // Active turns stop at priority 120. Keep channel backflow alive until
    // their terminal events have been emitted, then close adapters at 100.
    onShutdown(`adapter-${handle.name}`, 100, () => handle.stop());
    return handle;
  };
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await node.stop();
  };

  try {
    if (selected.has("otium")) {
      const { handleOtiumPeerRequest, startOtiumWorker } = await import("@negotium/adapter-otium");
      const worker = startOtiumWorker();
      if (!worker) throw new Error("Otium is not joined; run `negotium otium join <code>`");
      registerNodeRequestHandler("otium-peer", handleOtiumPeerRequest);
      mount({
        name: "otium",
        stop(): void {
          unregisterNodeRequestHandler("otium-peer");
          worker.stop();
        },
      });
    }

    if (selected.has("telegram")) {
      const { startTelegramFromEnv } = await import("@negotium/adapter-telegram/cli");
      mount(startTelegramFromEnv());
    }

    if (selected.has("terminal")) {
      const { startTerminalAdapter } = await import("@negotium/adapter-terminal");
      const { terminalOptionsFromArgs } = await import("@negotium/adapter-terminal/cli");
      const terminal = startTerminalAdapter({
        ...terminalOptionsFromArgs(args),
        startNode: false,
      });
      mount(terminal);
      terminalCompleted = terminal.completed;
    }

    if (terminalCompleted) {
      await terminalCompleted;
    } else {
      process.stdout.write(
        `negotium node :${node.port} — adapters: ${[...selected].join(", ")} (ctrl-c to stop)\n`,
      );
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    }
  } finally {
    await stop();
  }
}
