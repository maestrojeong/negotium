/** `negotium topics` — list topics on this node. */

import { getTopics } from "@negotium/core";

export function topicsCommand(): void {
  const topics = getTopics();
  if (topics.length === 0) {
    console.log("no topics yet — `negotium chat <name>` creates one");
    return;
  }
  for (const t of topics) {
    const flags = [t.isSubagent ? "subagent" : null, t.isFork ? "fork" : null]
      .filter(Boolean)
      .join(",");
    console.log(
      `${t.title}  ${t.agent ?? "no-ai"}${t.defaultModel ? `/${t.defaultModel}` : ""}` +
        `${flags ? `  [${flags}]` : ""}  ${t.id}`,
    );
  }
}
