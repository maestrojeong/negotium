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
 */

export {};

const [, , command, ...args] = process.argv;

switch (command) {
  case "init": {
    const { initCommand } = await import("./commands/init");
    initCommand();
    break;
  }
  case "chat": {
    const { chatCommand } = await import("./commands/chat");
    await chatCommand(args);
    break;
  }
  case "serve": {
    const { startDefaultNode } = await import("./node");
    const node = await startDefaultNode();
    console.log(`negotium node listening on 127.0.0.1:${node.port} (ctrl-c to stop)`);
    process.on("SIGINT", () => {
      node.stop();
      process.exit(0);
    });
    await new Promise(() => {});
    break;
  }
  case "topics": {
    const { topicsCommand } = await import("./commands/topics");
    topicsCommand();
    break;
  }
  case "mcp": {
    const { mcpCommand } = await import("./commands/mcp");
    mcpCommand(args);
    break;
  }
  case "vault": {
    const { vaultCommand } = await import("./commands/vault");
    vaultCommand(args);
    break;
  }
  case "cron": {
    const { cronCommand } = await import("./commands/cron");
    cronCommand(args);
    break;
  }
  default: {
    console.log(
      [
        "negotium — turn this computer into an agent node",
        "",
        "usage: negotium <init|chat|serve|topics|mcp|vault|cron> [args]",
        "",
        "  init            bootstrap ~/.negotium and check agent auth",
        "  chat [topic]    interactive chat (creates the topic if missing)",
        "                  options: --agent=claude|codex|maestro",
        "  serve           headless node: MCP endpoint + queue workers",
        "  topics          list topics on this node",
        "  mcp list|add|remove|enable|disable   manage node MCP manifest",
        "  vault list|set|get|del               node secret store (encrypted at rest)",
        "  cron list|create|inspect|run|pause|resume|reset|delete",
      ].join("\n"),
    );
    if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}
