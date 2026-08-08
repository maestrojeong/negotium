/** `negotium topics` — list topics on this node. */

import { getVisibleTopics } from "@negotium/core";

export function topicsCommand(): void {
  // The CLI is part of the Terminal product, so it lists the terminal surface
  // and nothing else — exactly what the Terminal picker shows. On a host that
  // only serves Otium rooms this is legitimately empty, and printing that
  // host's Otium rooms here would put them on the wrong surface's list.
  const topics = getVisibleTopics({ surface: "terminal" });
  if (topics.length === 0) {
    console.log("no topics yet - start `negotium` to create one in Terminal");
    return;
  }
  for (const t of topics) {
    const model = t.effectiveModel ?? t.defaultModel;
    const flags = [t.isSubagent ? "subagent" : null, t.isFork ? "fork" : null]
      .filter(Boolean)
      .join(",");
    console.log(
      `${t.title}  ${t.agent ?? "no-ai"}${model ? `/${model}` : ""}` +
        `${flags ? `  [${flags}]` : ""}  ${t.id}`,
    );
  }
}
