#!/usr/bin/env bun
/**
 * negotium — turn this computer into an agent node.
 *
 *   negotium init            bootstrap ~/.negotium and report agent auth
 *   negotium chat [topic]    interactive terminal chat (reference host)
 *   negotium serve           headless node (MCP endpoint + inbox worker)
 *   negotium topics          list topics on this node
 *   negotium mcp ...         manage this node's MCP manifest
 *   negotium cron ...        manage persistent scheduled agent turns
 *   negotium terminal        full-screen terminal adapter
 *   negotium telegram        Telegram adapter configured from env
 *   negotium otium ...       join or serve as an Otium worker
 */

export {};

const [, , command, ...args] = process.argv;

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
    const node = await startDefaultNode();
    console.log(`negotium node listening on 127.0.0.1:${node.port} (ctrl-c to stop)`);
    await new Promise<void>((resolve) => {
      const finish = () => {
        void node.stop().then(resolve);
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    });
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
    const { runTerminalCli } = await import("@negotium/adapter-terminal/cli");
    await runTerminalCli(args);
    break;
  }
  case "telegram": {
    const { runTelegramCli } = await import("@negotium/adapter-telegram/cli");
    await runTelegramCli();
    break;
  }
  case "otium": {
    const { runOtiumCli } = await import("@negotium/adapter-otium/cli");
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
        "usage: negotium <init|chat|serve|topics|mcp|vault|cron|terminal|telegram|otium|start> [args]",
        "",
        "  init            bootstrap ~/.negotium and check agent auth",
        "  chat [topic]    interactive chat (creates the topic if missing)",
        "                  options: --agent=claude|codex|maestro",
        "  serve           headless node: MCP endpoint + queue workers",
        "  topics          list topics on this node",
        "  mcp list|add|remove|enable|disable   manage node MCP manifest",
        "  vault list|set|get|del               node secret store (encrypted at rest)",
        "  cron list|create|inspect|logs|run|pause|resume|restart|kill|reset|delete",
        "  terminal        full-screen local TUI adapter",
        "  telegram        Telegram adapter (configured from environment)",
        "  otium join|serve  join an Otium workspace or serve its worker routes",
        "  start [terminal telegram otium|all]  run adapters together on one node",
      ].join("\n"),
    );
    if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}
