/** `negotium init` — bootstrap the node state dir and report agent auth. */

import {
  checkAgentAuth,
  DATA_DIR,
  RUN_DIR,
  STATE_DIR,
  SUPPORTED_AGENTS,
  WORKSPACE_DIR,
} from "@negotium/core";

export function initCommand(): void {
  // Importing core already created the layout — this command makes it visible.
  console.log("negotium node initialized\n");
  console.log(`  state:     ${STATE_DIR}`);
  console.log(`  data:      ${DATA_DIR}`);
  console.log(`  run:       ${RUN_DIR}`);
  console.log(`  workspace: ${WORKSPACE_DIR}\n`);

  console.log("agents:");
  for (const agent of SUPPORTED_AGENTS) {
    const auth = checkAgentAuth(agent);
    console.log(`  ${agent.padEnd(8)} ${auth.ok ? "ready" : `unavailable — ${auth.error}`}`);
  }
  console.log("\nnext: `negotium` or `negotium serve`");
}
