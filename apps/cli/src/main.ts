#!/usr/bin/env bun

import { loadOtiumCli, loadTelegramCli, loadTerminalCli } from "@/adapter-loader";

const [, , command, ...args] = process.argv;

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
  case "chat": {
    const { chatCommand } = await import("@/commands/chat");
    await chatCommand(args);
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
  case "start":
  case "adapters": {
    const { adaptersCommand } = await import("@/commands/adapters");
    await adaptersCommand(args);
    break;
  }
  default: {
    console.log(
      [
        "negotium — turn this computer into an agent node",
        "",
        "usage: negotium <init|chat|serve|status|stop|topics|mcp|vault|cron|terminal|telegram|otium|start> [args]",
        "",
        "  init            bootstrap ~/.negotium and check agent auth",
        "  chat [topic]    interactive chat (creates the topic if missing)",
        "                  options: --agent=claude|codex|maestro",
        "  serve           foreground canonical node (default port 7777)",
        "  serve otium     ensure the canonical node and run the Otium sidecar",
        "  status          show the canonical node and adapter processes",
        "  stop [otium|telegram|--all]  stop the node, one adapter, or everything",
        "  topics          list topics on this node",
        "  mcp list|add|remove|enable|disable   manage node MCP manifest",
        "  vault list|set|get|del               node secret store (encrypted at rest)",
        "  cron list|create|inspect|logs|run|pause|resume|restart|kill|reset|delete",
        "  terminal        TUI client; auto-starts and connects to the local node",
        "                  options: --embedded, --connect=http://host:port, --port=N",
        "  telegram        Telegram adapter (configured from environment)",
        "  otium join|serve  join an Otium workspace or serve its worker routes",
        "  start <terminal|telegram|otium>  run one channel process",
        "                  Terminal clients may run more than once and share one node",
      ].join("\n"),
    );
    if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}
