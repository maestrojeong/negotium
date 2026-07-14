/**
 * `negotium-otium join <code>` — attach this node to an otium workspace as a
 * worker. The code is the v0 invite bundle (base64url JSON
 * {v, central, cellId, secret}) printed by the hub operator's
 * experiment/hub-setup.ts. Credentials persist under
 * `${DATA_DIR}/otium-join.json` (0600); `negotium-otium serve` mounts the otium
 * peer routes whenever that file exists.
 */

import { configureOtiumCentral, selfPeerNode } from "@/central";
import { parseInviteCode, saveJoin } from "@/join";

export async function joinCommand(args: string[]): Promise<void> {
  const code = args[0]?.trim();
  if (!code) {
    console.error("usage: negotium-otium join <invite-code>");
    process.exitCode = 1;
    return;
  }

  let join: ReturnType<typeof parseInviteCode>;
  try {
    join = parseInviteCode(code);
  } catch (err) {
    console.error(`invalid invite code: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }

  const path = saveJoin(join);
  console.log(`otium join credentials saved to ${path}`);
  console.log(`  central: ${join.central}`);
  console.log(`  cellId:  ${join.cellId}`);

  // Self check: confirm the assignment exists and surface the node name.
  configureOtiumCentral(join);
  try {
    const self = await selfPeerNode();
    if (self) {
      console.log(
        `attached to workspace as "${self.nodeName ?? self.cellId}" (baseUrl ${self.baseUrl})`,
      );
    } else {
      console.warn(
        "warning: central answered but this cell has no visible assignment yet — check the workspace assignment",
      );
    }
  } catch (err) {
    console.warn(
      `warning: could not verify against central (${err instanceof Error ? err.message : err}) — credentials saved anyway`,
    );
  } finally {
    configureOtiumCentral(null);
  }
  console.log("\nnext: `negotium-otium serve` (mounts the otium peer routes automatically)");
}
