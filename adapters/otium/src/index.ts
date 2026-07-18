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
} from "@negotium/core";
import { startCanonicalMcpBridge } from "@/canonical-mcp-bridge";
import { configureOtiumCentral, selfPeerNode } from "@/central";
import { startEventBackflow } from "@/event-backflow";
import { loadJoin, type OtiumJoin } from "@/join";
import { installPeerFileHooks } from "@/peer-files";
import { otiumPeerRuntimeBridge } from "@/runtime-bridge";
import { otiumPeerSessionBridge, startPeerReplyOutboxWorker } from "@/session-bridge";
import { startPeerSessionBridgeIpc } from "@/session-bridge-ipc";
import { cleanupPeerStateForLocalTopic, failInterruptedPeerTurnRequestsOnStartup } from "@/store";
import { TunnelClient, type TunnelClientOptions } from "@/tunnel-client";

export {
  bindOtiumTopic,
  listOtiumTopicBindings,
  type OtiumTopicBinding,
  type OtiumTopicBindingResult,
  type OtiumTopicPrivateResult,
  setOtiumTopicPrivate,
  shareOtiumTopic,
  unbindOtiumTopic,
} from "@/bindings";

export {
  configureOtiumCentral,
  listPeerNodes,
  mintPeerToken,
  otiumCentralConfig,
  type PeerNode,
  resetPeerCentralCaches,
  resolvePeerNodeByCellId,
  selfPeerNode,
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
  createTurnForwarder,
  getActiveForwarder,
  hubEventSender,
  registerTurnForwarder,
  type SendPeerEvent,
  startEventBackflow,
  stopEventBackflow,
  type TurnForwarder,
  translateBusEvent,
} from "@/event-backflow";
export {
  isJoinPersisted,
  joinFilePath,
  loadJoin,
  type OtiumJoin,
  parseInviteCode,
  type SaveJoinOptions,
  saveJoin,
} from "@/join";
export { handleOtiumPeerRequest } from "@/peer-server";
export {
  PEER_PROTOCOL_VERSION,
  type PeerEventRequest,
  type PeerProvisionRequest,
  type PeerTurnRequest,
  type PlacedTopicExecutionSpec,
} from "@/protocol";
export {
  type HeaderPairs as RelayHeaderPairs,
  PROTOCOL_VERSION as RELAY_PROTOCOL_VERSION,
} from "@/relay-protocol";
export { otiumPeerRuntimeBridge } from "@/runtime-bridge";
export { cleanupPeerStateForLocalTopic, failInterruptedPeerTurnRequestsOnStartup } from "@/store";
export {
  TunnelClient,
  type TunnelClientOptions,
  type TunnelLogger,
  type TunnelStatus,
} from "@/tunnel-client";
export {
  abortHostedPeerTurn,
  provisionMirrorTopic,
  type RunPeerTurnResult,
  runPeerTurn,
} from "@/turn-bridge";

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

/** Start the runtime half of Otium inside the canonical Node process. */
export function startOtiumNodeRuntime(options: OtiumAdapterOptions): OtiumNodeRuntimeHandle {
  const { join } = options;
  configureOtiumCentral(join);
  const failed = failInterruptedPeerTurnRequestsOnStartup();
  if (failed > 0) {
    logger.warn({ failed }, "otium: failed interrupted peer turns from previous process");
  }
  const stopBackflow = startEventBackflow();
  const unregisterRuntimeBridge = registerPeerRuntimeBridge(otiumPeerRuntimeBridge);
  const unregisterSessionBridge = registerPeerSessionBridge(otiumPeerSessionBridge);
  const sessionBridgeIpc = startPeerSessionBridgeIpc(otiumPeerSessionBridge);
  const canonicalMcpBridge = startCanonicalMcpBridge();
  const stopPeerReplyOutbox = startPeerReplyOutboxWorker();
  void failInterruptedRemoteAskCallbacks().then((failedAsks) => {
    if (failedAsks > 0) {
      logger.warn({ failedAsks }, "otium: failed remote asks interrupted by previous process");
    }
  });
  const uninstallFileHooks = installPeerFileHooks();
  const unsubscribeTopicCleanup = runtimeBus().subscribe((event) => {
    if (event.type !== "topic-deleted") return;
    const removed = cleanupPeerStateForLocalTopic(event.topicId);
    if (removed.sessions + removed.turns + removed.inboxRequests + removed.remoteAsks > 0) {
      logger.info(
        { topicId: event.topicId, ...removed },
        "otium: removed peer state for deleted local topic",
      );
    }
  });
  let stopped = false;
  logger.info({ central: join.central, cellId: join.cellId }, "otium: worker mode enabled");
  void selfPeerNode()
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
  return {
    name: "otium",
    join,
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribeTopicCleanup();
      unregisterRuntimeBridge();
      unregisterSessionBridge();
      sessionBridgeIpc.stop();
      canonicalMcpBridge.stop();
      stopPeerReplyOutbox();
      uninstallFileHooks();
      stopBackflow();
      configureOtiumCentral(null);
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
    externalPlacedTurn: true,
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
 * point the central client at it, fail interrupted turns from a previous
 * process, and start the bus → hub event backflow. Returns null (and mounts
 * nothing) when the node has not joined a workspace. Otium-aware hosts call
 * this before starting the shared node.
 */
export function startOtiumWorker(): OtiumWorkerHandle | null {
  const join = loadJoin();
  if (!join) return null;
  return startOtiumAdapter({ join });
}
