/**
 * Ask a *running* canonical node to re-read the join file (M-7).
 *
 * `join` and `leave` run in their own short-lived process, so writing the
 * credential file changes nothing about the node that is already serving. Rather
 * than telling the operator to restart — which drops every other workspace's
 * tunnel to add or remove one — the CLI pokes the node over the same
 * authenticated loopback control prefix the sidecar already uses, and the node
 * reconciles its attachments against the file.
 *
 * Failure is not an error: a node that is not running has nothing to reconcile,
 * and will pick the file up when it starts.
 */

import { NODE_CONTROL_TOKEN } from "@negotium/core";
import {
  OTIUM_ADAPTER_CONTROL_HEADER,
  OTIUM_ADAPTER_CONTROL_PREFIX,
  OTIUM_WORKSPACES_CONTROL_PATH,
} from "@/control-protocol";

export interface WorkspaceReconcileResult {
  ok: boolean;
  attached: string[];
  detached: string[];
  /** Why the running node could not be reached, when it could not. */
  error?: string;
}

export async function reconcileRunningNodeWorkspaces(): Promise<WorkspaceReconcileResult> {
  try {
    const { inspectNodeDaemon } = await import("@negotium/node");
    const status = await inspectNodeDaemon();
    if (!status.running || !status.info) {
      return { ok: false, attached: [], detached: [], error: "node is not running" };
    }
    const response = await fetch(
      `http://127.0.0.1:${status.info.port}${OTIUM_ADAPTER_CONTROL_PREFIX}${OTIUM_WORKSPACES_CONTROL_PATH}`,
      {
        method: "POST",
        headers: {
          [OTIUM_ADAPTER_CONTROL_HEADER]: NODE_CONTROL_TOKEN,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      attached?: string[];
      detached?: string[];
      error?: string;
    } | null;
    if (!response.ok || !body?.ok) {
      return {
        ok: false,
        attached: [],
        detached: [],
        error: body?.error ?? `node returned ${response.status}`,
      };
    }
    return { ok: true, attached: body.attached ?? [], detached: body.detached ?? [] };
  } catch (error) {
    return { ok: false, attached: [], detached: [], error: (error as Error).message };
  }
}
