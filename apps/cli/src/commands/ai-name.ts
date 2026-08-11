/**
 * `negotium ai-name [get|set|reset]` — this node's own AI persona name.
 *
 * Node-local only: it changes what THIS node's agents call themselves in the
 * system prompt ({{AI_LABEL}} in topic-system.md), stored in this node's own
 * `otium-settings.json`. It has nothing to do with any single topic/room, and
 * nothing here ever reaches another node (hub or worker) over the network —
 * each computer keeps its own name.
 */

import { DEFAULT_AI_NAME, getGlobalAiName, setGlobalAiName } from "@negotium/core";

export function aiNameCommand(args: string[]): void {
  const [sub, ...rest] = args;

  switch (sub) {
    case undefined:
    case "get": {
      console.log(getGlobalAiName());
      return;
    }
    case "set": {
      const name = rest.join(" ").trim();
      if (!name) {
        console.error("usage: negotium ai-name set <name>");
        process.exitCode = 1;
        return;
      }
      console.log(setGlobalAiName(name));
      return;
    }
    case "reset": {
      console.log(setGlobalAiName(DEFAULT_AI_NAME));
      return;
    }
    default:
      console.error(`unknown subcommand "${sub}" — use get|set|reset`);
      process.exitCode = 1;
  }
}
