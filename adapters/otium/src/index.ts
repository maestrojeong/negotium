/**
 * @negotium/adapter-otium public API.
 *
 * Turns an embedded negotium runtime into an otium workspace **worker node**
 * (docs/OTIUM-COUPLING.md). A host wires it in three lines:
 *
 *   const worker = startOtiumWorker();           // no-op when not joined
 *   Bun.serve({ fetch: async (req) =>
 *     (await handleOtiumPeerRequest(req)) ?? (await handleNegotiumMcpRequest(req)) ?? … });
 */

import { defineNegotiumAdapter, type NegotiumAdapterHandle } from "@negotium/adapter-sdk";
import {
  failInterruptedRemoteAskCallbacks,
  logger,
  NEGOTIUM_VERSION,
  registerPeerRuntimeBridge,
  registerPeerSessionBridge,
  runtimeBus,
  setDefaultSurfaceScope,
  setSurfaceScopeRequired,
  stampUnscopedOtiumTopics,
} from "@negotium/core";
import { startCanonicalMcpBridge } from "@/canonical-mcp-bridge";
import { attachOtiumCentralCell, detachOtiumCentralCell, selfPeerNodeForCell } from "@/central";
import { loadJoin, type OtiumJoin } from "@/join";
import { installPeerFileHooks } from "@/peer-files";
import { otiumPeerRuntimeBridge } from "@/runtime-bridge";
import { otiumPeerSessionBridge, startPeerReplyOutboxWorker } from "@/session-bridge";
import { startPeerSessionBridgeIpc } from "@/session-bridge-ipc";
import { cleanupPeerStateForLocalTopic } from "@/store";
import { TunnelClient, type TunnelClientOptions } from "@/tunnel-client";
import { cachedSurfaceScope, resolveSurfaceScope } from "@/workspace-scope";

export {
  attachedOtiumCells,
  attachOtiumCentralCell,
  configureOtiumCentral,
  detachOtiumCentralCell,
  isOtiumCentralConfigured,
  listPeerNodes,
  listPeerNodesForCell,
  mintPeerToken,
  otiumCentralConfig,
  type PeerNode,
  peerWorkspaceId,
  peerWorkspaceIdForCell,
  resetPeerCentralCaches,
  resolvePeerNodeByCellId,
  selfPeerNode,
  selfPeerNodeForCell,
  type VerifiedPeer,
  verifyPeerToken,
} from "@/central";
export {
  claimEnrollment,
  commitEnrollment,
  type EnrollmentCredentialEnvelope,
  type EnrollmentInvite,
  isEnrollmentPending,
  parseEnrollmentInvite,
  pendingEnrollmentPath,
  previewEnrollment,
} from "@/enrollment";
export {
  isJoinPersisted,
  joinFilePath,
  loadJoin,
  type OtiumJoin,
  parseInviteCode,
  removeJoin,
  type SaveJoinOptions,
  saveJoin,
} from "@/join";
export { handleOtiumPeerRequest } from "@/peer-server";
export { PEER_PROTOCOL_VERSION, type PeerSessionEntry } from "@/protocol";
export {
  type HeaderPairs as RelayHeaderPairs,
  PROTOCOL_VERSION as RELAY_PROTOCOL_VERSION,
} from "@/relay-protocol";
export { otiumPeerRuntimeBridge } from "@/runtime-bridge";
export { cleanupPeerStateForLocalTopic } from "@/store";
export {
  TunnelClient,
  type TunnelClientOptions,
  type TunnelLogger,
  type TunnelStatus,
} from "@/tunnel-client";
export {
  cachedSurfaceScope,
  resolveSurfaceScope,
  surfaceScopeFor,
  surfaceScopeForCell,
  type WorkspaceScopeRecord,
} from "@/workspace-scope";

export interface OtiumAdapterOptions {
  join: OtiumJoin;
}

export interface OtiumWorkerHandle extends NegotiumAdapterHandle<"otium"> {
  join: OtiumJoin;
  startTunnel(options: Pick<TunnelClientOptions, "targetOrigin"> & { relayUrl?: string }): void;
}

/** Runtime-owned Otium services. This handle must live in the canonical Node process. */
export interface OtiumNodeRuntimeHandle extends NegotiumAdapterHandle<"otium"> {
  join: OtiumJoin;
}

/**
 * Bridges that are global by nature — one per process regardless of how many
 * workspaces are attached (M-6).
 *
 * The runtime bridge, session bridge, canonical MCP bridge, file hooks, the
 * topic-deleted subscription and the reply outbox all address rooms and turns,
 * not workspaces; a second copy of any of them would deliver every event twice.
 * They are therefore refcounted: started with the first attachment and stopped
 * with the last, so a node that leaves one workspace keeps serving the rest.
 */
let globalServices: { stop: () => void; refs: number } | null = null;

function acquireGlobalOtiumServices(): () => void {
  if (globalServices) {
    globalServices.refs += 1;
  } else {
    const unregisterRuntimeBridge = registerPeerRuntimeBridge(otiumPeerRuntimeBridge);
    const unregisterSessionBridge = registerPeerSessionBridge(otiumPeerSessionBridge);
    const sessionBridgeIpc = startPeerSessionBridgeIpc(otiumPeerSessionBridge);
    const canonicalMcpBridge = startCanonicalMcpBridge();
    const stopPeerReplyOutbox = startPeerReplyOutboxWorker();
    const uninstallFileHooks = installPeerFileHooks();
    const unsubscribeTopicCleanup = runtimeBus().subscribe((event) => {
      if (event.type !== "topic-deleted") return;
      const removed = cleanupPeerStateForLocalTopic(event.topicId);
      if (removed.inboxRequests + removed.remoteAsks > 0) {
        logger.info(
          { topicId: event.topicId, ...removed },
          "otium: removed peer state for deleted local topic",
        );
      }
    });
    void failInterruptedRemoteAskCallbacks().then((failedAsks) => {
      if (failedAsks > 0) {
        logger.warn({ failedAsks }, "otium: failed remote asks interrupted by previous process");
      }
    });
    globalServices = {
      refs: 1,
      stop: () => {
        unsubscribeTopicCleanup();
        unregisterRuntimeBridge();
        unregisterSessionBridge();
        sessionBridgeIpc.stop();
        canonicalMcpBridge.stop();
        stopPeerReplyOutbox();
        uninstallFileHooks();
      },
    };
  }
  let released = false;
  return () => {
    if (released || !globalServices) return;
    released = true;
    globalServices.refs -= 1;
    if (globalServices.refs > 0) return;
    globalServices.stop();
    globalServices = null;
  };
}

/**
 * The workspace new rooms fall back to when nobody names one.
 *
 * With a single workspace attached this is that workspace, which is what every
 * pre-multi-join caller means. With several attached there is no honest answer:
 * an unattributed Otium room belongs to no particular workspace, and silently
 * picking one would hand it to whichever Central answered first. It is filed
 * unscoped instead — reachable from any of them, like the rooms that predate
 * the column — and callers that *do* know the workspace (the gateway, peer
 * routes, derived rooms) state it explicitly.
 */
const mountedScopes = new Map<string, string | null>();

function refreshDefaultSurfaceScope(): void {
  const scopes = [...mountedScopes.values()];
  setDefaultSurfaceScope(scopes.length === 1 ? (scopes[0] ?? null) : null);
  // With several attached there is no default to fall back on, so a room that
  // names no workspace is refused rather than filed where nobody can see it.
  setSurfaceScopeRequired(scopes.length > 1);
}

/**
 * Attach one workspace inside the canonical Node process.
 *
 * One instance per joined workspace (M-6). Only the credentials, the workspace
 * scope and the self-check are per workspace; everything else is shared and
 * refcounted above.
 */
export function startOtiumNodeRuntime(options: OtiumAdapterOptions): OtiumNodeRuntimeHandle {
  const { join } = options;
  attachOtiumCentralCell(join);
  const releaseGlobals = acquireGlobalOtiumServices();
  let stopped = false;
  logger.info({ central: join.central, cellId: join.cellId }, "otium: worker mode enabled");
  // Seed from the last known scope so rooms created between mount and the first
  // Central answer are still filed correctly; the async resolution below only
  // matters on the very first attachment to a workspace (M-3).
  mountedScopes.set(join.cellId, cachedSurfaceScope(join));
  refreshDefaultSurfaceScope();
  void selfPeerNodeForCell(join.cellId)
    .then((self) => {
      if (self) {
        logger.info(
          { nodeName: self.nodeName, baseUrl: self.baseUrl },
          "otium: attached to workspace",
        );
      }
    })
    .catch((err) => {
      logger.warn({ err }, "otium: self check against central failed (will retry per request)");
    });
  void resolveSurfaceScope(join)
    .then((scope) => {
      if (!scope || stopped) return;
      mountedScopes.set(join.cellId, scope);
      refreshDefaultSurfaceScope();
      // M-9 — rooms that predate the scope column belong to whatever workspace
      // this node was attached to when it upgraded. That is only answerable
      // while exactly one workspace is attached; with several, the first
      // Central to answer would otherwise claim rooms that may not be its own.
      if (mountedScopes.size === 1) stampUnscopedOtiumTopics(scope);
    })
    .catch((err) => {
      logger.warn({ err }, "otium: workspace scope resolution failed");
    });
  return {
    name: "otium",
    join,
    stop: () => {
      if (stopped) return;
      stopped = true;
      // Leaving removes credentials and nothing else (M-4): the rooms of this
      // workspace stay, keep their scope and keep executing locally.
      mountedScopes.delete(join.cellId);
      refreshDefaultSurfaceScope();
      detachOtiumCentralCell(join.cellId);
      releaseGlobals();
    },
  };
}

/**
 * Backward-compatible embedded composition. New hosts should run
 * `startOtiumNodeRuntime` in the canonical Node and the tunnel in a sidecar.
 */
export function startOtiumAdapter(options: OtiumAdapterOptions): OtiumWorkerHandle {
  const runtime = startOtiumNodeRuntime(options);
  let tunnel: TunnelClient | null = null;
  let stopped = false;
  return {
    name: "otium",
    join: runtime.join,
    startTunnel: ({ targetOrigin, relayUrl }) => {
      if (stopped || tunnel) return;
      const selectedRelay =
        relayUrl?.trim() || runtime.join.relay || process.env.OTIUM_RELAY_URL?.trim();
      if (!selectedRelay) {
        logger.info({}, "otium: relay tunnel disabled (no relay URL configured)");
        return;
      }
      tunnel = new TunnelClient({
        relayUrl: selectedRelay,
        token: runtime.join.secret,
        targetOrigin,
        nodeVersion: `negotium@${NEGOTIUM_VERSION}`,
        logger,
      });
      tunnel.start();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      tunnel?.stop();
      tunnel = null;
      runtime.stop();
    },
  };
}

/** Declarative form used by hosts that load adapters from a registry. */
export const otiumAdapter = defineNegotiumAdapter({
  name: "otium",
  capabilities: {
    localUserInput: false,
    topicManagement: false,
    // The hub no longer places rooms on this node; it drives a canonical local
    // topic over the Runtime Gateway instead, so turns are not "external".
    externalPlacedTurn: false,
  },
  projection: {
    transcript: "full",
    // The hub has no generic bound-topic projection/backfill endpoint yet.
    historyBackfill: false,
    externalAuthors: "relayed",
  },
  start: startOtiumAdapter,
});

/**
 * Wire this node up as an otium worker: load the join file (or env triple),
 * point the central client at it, and register the cross-node session and
 * runtime bridges. Returns null (and mounts nothing) when the node has not
 * joined a workspace. Otium-aware hosts call this before starting the shared
 * node.
 */
export function startOtiumWorker(): OtiumWorkerHandle | null {
  const join = loadJoin();
  if (!join) return null;
  return startOtiumAdapter({ join });
}
