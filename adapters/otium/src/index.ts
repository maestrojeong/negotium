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
  registerPeerRuntimeBridge,
  registerPeerSessionBridge,
  runtimeBus,
} from "@negotium/core";
import { configureOtiumCentral, selfPeerNode } from "@/central";
import { startEventBackflow } from "@/event-backflow";
import { loadJoin, type OtiumJoin } from "@/join";
import { installPeerFileHooks } from "@/peer-files";
import { otiumPeerRuntimeBridge } from "@/runtime-bridge";
import { otiumPeerSessionBridge, startPeerReplyOutboxWorker } from "@/session-bridge";
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
  type EnrollmentCredentialEnvelope,
  type EnrollmentInvite,
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
export { joinFilePath, loadJoin, type OtiumJoin, parseInviteCode, saveJoin } from "@/join";
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

/** Start the configured Otium channel adapter. */
export function startOtiumAdapter(options: OtiumAdapterOptions): OtiumWorkerHandle {
  const { join } = options;
  configureOtiumCentral(join);
  const failed = failInterruptedPeerTurnRequestsOnStartup();
  if (failed > 0) {
    logger.warn({ failed }, "otium: failed interrupted peer turns from previous process");
  }
  const stopBackflow = startEventBackflow();
  const unregisterRuntimeBridge = registerPeerRuntimeBridge(otiumPeerRuntimeBridge);
  const unregisterSessionBridge = registerPeerSessionBridge(otiumPeerSessionBridge);
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
  let tunnel: TunnelClient | null = null;
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
    startTunnel: ({ targetOrigin, relayUrl }) => {
      if (stopped || tunnel) return;
      const selectedRelay = relayUrl?.trim() || join.relay || process.env.OTIUM_RELAY_URL?.trim();
      if (!selectedRelay) {
        logger.info({}, "otium: relay tunnel disabled (no relay URL configured)");
        return;
      }
      tunnel = new TunnelClient({
        relayUrl: selectedRelay,
        token: join.secret,
        targetOrigin,
        nodeVersion: "@negotium/adapter-otium@0.1.4",
        logger,
      });
      tunnel.start();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      tunnel?.stop();
      tunnel = null;
      unsubscribeTopicCleanup();
      unregisterRuntimeBridge();
      unregisterSessionBridge();
      stopPeerReplyOutbox();
      uninstallFileHooks();
      stopBackflow();
      configureOtiumCentral(null);
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
