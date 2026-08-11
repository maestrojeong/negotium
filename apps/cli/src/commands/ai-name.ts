/**
 * `negotium ai-name [name]` — this node's own AI persona name.
 *
 * Node-local only: it changes what THIS node's agents call themselves in the
 * system prompt ({{AI_LABEL}} in topic-system.md), stored in this node's own
 * `otium-settings.json`. It has nothing to do with any single topic/room, and
 * nothing here ever reaches another node (hub or worker) over the network —
 * each computer keeps its own name.
 *
 * No args prints the current name; any other argument sets it directly
 * (`negotium ai-name Jarvis`), so naming this node is a one-liner. `reset`
 * restores the default, and `get`/`set <name>` still work for scripts that
 * want an explicit verb.
 */

import { DEFAULT_AI_NAME, getGlobalAiName, setGlobalAiName } from "@negotium/core";

export function aiNameCommand(args: string[]): void {
  const [first, ...rest] = args;

  switch (first) {
    case undefined:
    case "get": {
      console.log(getGlobalAiName());
      return;
    }
    case "reset": {
      console.log(setGlobalAiName(DEFAULT_AI_NAME));
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
    default: {
      // The common case: `negotium ai-name <name>` sets it directly, no verb
      // needed. Use `ai-name set <name>` instead if the name itself happens
      // to be "get" or "reset".
      const name = [first, ...rest].join(" ").trim();
      console.log(setGlobalAiName(name));
    }
  }
}
