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
    const { startDefaultNode } = await import("@negotium/node");
    const node = await startDefaultNode({
      port: numericOption(args, "port", 7777),
      advertise: true,
      singleton: true,
    });
    console.log(`negotium node listening on 127.0.0.1:${node.port} (ctrl-c to stop)`);
    await node.completed;
    break;
  }
  case "__node-daemon": {
    const { runNodeDaemon } = await import("@negotium/node");
    await runNodeDaemon({ port: numericOption(args, "port", 0) });
    break;
  }
  case "status": {
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
    break;
  }
  case "stop": {
    const { stopNodeDaemon } = await import("@negotium/node");
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
    await runTelegramCli();
    break;
  }
  case "otium": {
    const { runOtiumCli } = await loadOtiumCli();
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
        "  serve           foreground long-lived node (default port 7777)",
        "  status          show the local long-lived node status",
        "  stop            stop the local long-lived node",
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
