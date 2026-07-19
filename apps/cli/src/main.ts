#!/usr/bin/env bun

import { loadOtiumCli, loadTelegramCli, loadTerminalCli } from "@/adapter-loader";
import { normalizeCliCommand, renderCliHelp } from "@/command-catalog";

const [, , rawCommand, ...args] = process.argv;
const command = normalizeCliCommand(rawCommand);

function numericOption(values: string[], name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const parsed = Number.parseInt(
    values.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? "",
    10,
  );
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function runCanonicalNode(port: number): Promise<void> {
  const { onShutdown } = await import("@negotium/core");
  const { MAX_PEER_INPUT_REQUEST_BYTES, mountConfiguredOtiumNodeRuntime } = await import(
    "@negotium/adapter-otium/node-runtime"
  );
  const { startDefaultNode } = await import("@negotium/node");
  const otiumRuntime = mountConfiguredOtiumNodeRuntime();
  if (otiumRuntime) onShutdown("otium-node-runtime", 125, () => otiumRuntime.stop());
  const node = await startDefaultNode({
    port,
    advertise: true,
    singleton: true,
    maxRequestBodySize: MAX_PEER_INPUT_REQUEST_BYTES,
  });
  console.log(`negotium node listening on 127.0.0.1:${node.port} (ctrl-c to stop)`);
  await node.completed;
}

async function stopAdapter(name: "otium" | "telegram"): Promise<boolean> {
  const { getRuntimeProcessLease } = await import("@negotium/core");
  const lease = getRuntimeProcessLease(`adapter:${name}`);
  if (!lease) return false;
  try {
    process.kill(lease.pid, "SIGTERM");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

switch (command) {
  case "init": {
    const { initCommand } = await import("@/commands/init");
    initCommand();
    break;
  }
  case "-v":
  case "--version": {
    const { NEGOTIUM_VERSION } = await import("@negotium/core");
    console.log(NEGOTIUM_VERSION);
    break;
  }
  case "serve": {
    if (args[0] === "otium") {
      const { runOtiumCli } = await loadOtiumCli();
      await runOtiumCli(["serve", ...args.slice(1)]);
      break;
    }
    await runCanonicalNode(numericOption(args, "port", 7777));
    break;
  }
  case "__node-daemon": {
    await runCanonicalNode(numericOption(args, "port", 0));
    break;
  }
  case "status": {
    const { listRuntimeProcessLeases } = await import("@negotium/core");
    const { inspectNodeDaemon } = await import("@negotium/node");
    const status = await inspectNodeDaemon();
    if (status.running && status.info) {
      console.log(
        `negotium node running (pid ${status.info.pid}, 127.0.0.1:${status.info.port}, since ${status.info.startedAt})`,
      );
    } else if (status.info) {
      console.log(
        `negotium node not responding (last pid ${status.info.pid}${status.error ? `: ${status.error}` : ""})`,
      );
      process.exitCode = 1;
    } else {
      console.log("negotium node is stopped");
    }
    const adapters = listRuntimeProcessLeases("adapter:");
    if (adapters.length === 0) console.log("adapters: none");
    else {
      for (const adapter of adapters) {
        console.log(
          `adapter ${adapter.role.slice("adapter:".length)} running (pid ${adapter.pid}, since ${new Date(adapter.startedAt).toISOString()})`,
        );
      }
    }
    break;
  }
  case "stop": {
    const { stopNodeDaemon } = await import("@negotium/node");
    const target = args[0];
    if (target === "otium" || target === "telegram") {
      const stopped = await stopAdapter(target);
      console.log(
        stopped ? `${target} adapter shutdown requested` : `${target} adapter is not running`,
      );
      break;
    }
    if (target && target !== "--all") {
      throw new Error("usage: negotium stop [otium|telegram|--all]");
    }
    if (target === "--all") {
      for (const name of ["otium", "telegram"] as const) {
        if (await stopAdapter(name)) console.log(`${name} adapter shutdown requested`);
      }
    }
    const stopped = await stopNodeDaemon();
    console.log(stopped ? "negotium node shutdown requested" : "negotium node is not running");
    break;
  }
  case "topics": {
    const { topicsCommand } = await import("@/commands/topics");
    topicsCommand();
    break;
  }
  case "mcp": {
    const { mcpCommand } = await import("@/commands/mcp");
    mcpCommand(args);
    break;
  }
  case "vault": {
    const { vaultCommand } = await import("@/commands/vault");
    vaultCommand(args);
    break;
  }
  case "cron": {
    const { cronCommand } = await import("@/commands/cron");
    await cronCommand(args);
    break;
  }
  case "terminal": {
    const { runTerminalCli } = await loadTerminalCli();
    await runTerminalCli(args);
    break;
  }
  case "telegram": {
    const { runTelegramCli } = await loadTelegramCli();
    await runTelegramCli(args);
    break;
  }
  case "otium": {
    const { runOtiumCli } = await loadOtiumCli();
    if (args[0] === "serve") {
      process.stderr.write(
        "warning: `negotium otium serve` is deprecated; use `negotium serve otium`\n",
      );
    }
    await runOtiumCli(args);
    break;
  }
  default: {
    console.log(renderCliHelp());
    if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}
