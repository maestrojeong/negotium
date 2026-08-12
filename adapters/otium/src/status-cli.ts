/**
 * `negotium-otium status` — show which Otium workspace(s)/central server this
 * node is currently joined to.
 *
 * The join file (`${DATA_DIR}/otium-join.json`) is the only thing this command
 * strictly depends on: cellId, central, and (if present) relay are always
 * printed straight from it, so "am I joined" never needs a network round
 * trip to answer. Central is asked opportunistically, the same way `join`
 * does its post-join self-check, purely to surface the human-readable node
 * name and baseUrl the join file itself doesn't carry — no *workspace* name is
 * available from any endpoint reachable with just a cell secret (central only
 * hands back an opaque `workspaceId`), so this deliberately shows what's
 * locally known rather than adding a new backend lookup for it. A reachability
 * failure is reported as a warning, never turned into "not joined".
 */

import { attachOtiumCentralCell, configureOtiumCentral, selfPeerNodeForCell } from "@/central";
import { loadJoins } from "@/join";

export async function statusCommand(): Promise<void> {
  const joins = loadJoins();
  if (joins.length === 0) {
    console.log("not joined to any Otium workspace");
    process.exitCode = 1;
    return;
  }

  try {
    configureOtiumCentral(joins[0] ?? null);
    for (const join of joins.slice(1)) attachOtiumCentralCell(join);
    for (const [index, join] of joins.entries()) {
      if (index > 0) console.log("");
      console.log(`cellId:  ${join.cellId}`);
      console.log(`central: ${join.central}`);
      if (join.relay) console.log(`relay:   ${join.relay}`);
      try {
        const self = await selfPeerNodeForCell(join.cellId);
        if (self) {
          console.log(
            `node:    ${self.nodeName ?? join.cellId}${self.isPrimary ? " (primary)" : ""}`,
          );
          console.log(`baseUrl: ${self.baseUrl}`);
        } else {
          console.warn(
            "  warning: central answered but this cell has no visible assignment yet — check the workspace assignment",
          );
        }
      } catch (err) {
        console.warn(
          `  warning: could not verify against central (${err instanceof Error ? err.message : err}) — showing locally known info only`,
        );
      }
    }
  } finally {
    configureOtiumCentral(null);
  }
}
