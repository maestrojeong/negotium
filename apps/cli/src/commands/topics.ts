/** `negotium topics` — list topics on this node. */

import { getVisibleTopics } from "@negotium/core";

export function topicsCommand(): void {
  const topics = getVisibleTopics();
  if (topics.length === 0) {
    console.log("no topics yet - start `negotium` to create one in Terminal");
    return;
  }
  for (const t of topics) {
    const model = t.effectiveModel ?? t.defaultModel;
    const flags = [
      t.accessMode ?? "private",
      t.isSubagent ? "subagent" : null,
      t.isFork ? "fork" : null,
    ]
      .filter(Boolean)
      .join(",");
    console.log(
      `${t.title}  ${t.agent ?? "no-ai"}${model ? `/${model}` : ""}` +
        `${flags ? `  [${flags}]` : ""}  ${t.id}`,
    );
  }
}
