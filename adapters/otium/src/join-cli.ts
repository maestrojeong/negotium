/**
 * `negotium-otium join <code>` — attach this node to an otium workspace as a
 * worker. Production codes carry only `{v:2, central, token}`; the node
 * previews the workspace, creates an X25519 enrollment key, atomically claims
 * the invite, and decrypts the returned credential envelope. Credentials persist under
 * `${DATA_DIR}/otium-join.json` (0600); `negotium-otium serve` mounts the otium
 * peer routes whenever that file exists.
 */

import { hostname } from "node:os";
import { configureOtiumCentral, selfPeerNode } from "@/central";
import {
  claimEnrollment,
  commitEnrollment,
  isEnrollmentPending,
  parseEnrollmentInvite,
  previewEnrollment,
} from "@/enrollment";
import { parseInviteCode, saveJoin } from "@/join";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1]?.trim() : undefined;
}

/**
 * This machine's own default worker name — the OS hostname, lowercased and
 * trimmed to the node-name alphabet central accepts (`[a-z0-9._-]`, <= 32
 * chars). Central re-normalizes and de-duplicates it against the workspace's
 * other active nodes, so this only needs to be a reasonable first guess, not
 * a guaranteed-unique value.
 */
export function localNodeNameDefault(): string | undefined {
  const normalized = hostname()
    .trim()
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 32)
    .replace(/[-._]+$/g, "");
  return normalized || undefined;
}

async function confirmEnrollment(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(?:y|yes)$/i.test((await prompt.question(`${message} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

export async function joinCommand(args: string[]): Promise<void> {
  const code = args[0]?.trim();
  if (!code) {
    console.error(
      "usage: negotium-otium join <invite-code> [--yes] [--name <node-name>] [--legacy] [--replace]",
    );
    process.exitCode = 1;
    return;
  }

  let join: ReturnType<typeof parseInviteCode>;
  let productionEnrollment = false;
  if (args.includes("--legacy")) {
    try {
      join = parseInviteCode(code);
    } catch (err) {
      console.error(`invalid legacy invite code: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      return;
    }
  } else {
    try {
      const invite = parseEnrollmentInvite(code);
      const resuming = isEnrollmentPending(invite);
      // Prefer this machine's own identity over a blind admin guess: an
      // explicit `--name` wins, otherwise default to the local hostname (the
      // name this Negotium node is already known by), and only fall back to
      // the invite's `suggestedNodeName` if the hostname is unusable.
      let nodeName = option(args, "name") || localNodeNameDefault();
      if (resuming) {
        console.log(`Resuming interrupted Otium enrollment with ${invite.central}`);
      } else {
        const preview = await previewEnrollment(invite);
        const workspace = preview.preview?.workspace;
        nodeName ||= preview.preview?.suggestedNodeName || undefined;
        console.log(`Otium workspace: ${workspace?.name ?? workspace?.slug ?? workspace?.id}`);
        console.log(`  central:   ${invite.central}`);
        console.log(`  transport: ${preview.preview?.transport ?? "relay"}`);
        console.log(`  access:    ${preview.preview?.topics ?? "explicitly shared topics only"}`);
        const accepted =
          args.includes("--yes") || (await confirmEnrollment("Join this workspace?"));
        if (!accepted) {
          console.log("enrollment cancelled");
          return;
        }
      }
      join = await claimEnrollment(invite, nodeName);
      productionEnrollment = true;
    } catch (err) {
      console.error(`enrollment failed: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      return;
    }
  }

  let path: string;
  try {
    const saveOptions = { replaceExisting: args.includes("--replace") };
    path = productionEnrollment ? commitEnrollment(join, saveOptions) : saveJoin(join, saveOptions);
  } catch (err) {
    console.error(`could not save join credentials: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }
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

  // A running node keeps serving whatever it mounted at startup, so ask it to
  // reconcile against the file it has just gained a workspace in (M-7). The
  // very first join is the exception: a node with no Otium runtime has no
  // control route to poke, and has to be restarted once.
  const { reconcileRunningNodeWorkspaces } = await import("@/workspace-control");
  const applied = await reconcileRunningNodeWorkspaces();
  if (applied.ok && applied.attached.length > 0) {
    console.log("the running node attached this workspace; the others kept running");
    return;
  }
  console.log("\nnext: `negotium-otium serve` (mounts the otium peer routes automatically)");
}
