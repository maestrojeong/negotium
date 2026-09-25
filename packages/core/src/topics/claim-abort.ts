/**
 * Host create-claim abort (topic-link design v2 §4.2, PR7 review fixes 1/3).
 *
 * The decision is one `BEGIN IMMEDIATE` state machine, so no create from
 * another process can commit between "which state is this claim in" and what
 * the abort writes:
 *
 * - no claim          → aborted fence (a late create is refused)
 * - aborted           → idempotent
 * - committed, topic row gone → aborted
 * - committed, messages after the claim seed → refused, claim stays committed
 * - committed, protected topic → refused, claim stays committed
 * - committed, deletable → the runtime maintenance fence is taken IN THE SAME
 *   transaction with a `topic-link-abort:` owner. From that commit on, the
 *   `api_messages_claim_abort_fence` trigger refuses every message insert
 *   into the topic (any writer, any process), and the delete cascade re-checks
 *   "no messages after the seed" inside the transaction that deletes the
 *   messages and the topic row, flipping the claim to aborted in that very
 *   transaction. A message that still lands (stale fence) vetoes the delete:
 *   the topic is kept and the claim stays committed.
 *
 * A committed claim is therefore never aborted while its topic lives on.
 */

import { randomUUID } from "node:crypto";
import type { purgeTopicLogs } from "#agents/topic-cleanup";
import { GENERAL_TOPIC_ID } from "#platform/constants";
import { logger } from "#platform/logger";
import { getTopic } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import {
  beginRuntimeTopicMaintenance,
  type RuntimeTopicMaintenanceHandle,
} from "#storage/runtime-topic-state";
import {
  flipCommittedTopicCreateClaimToAborted,
  getTopicCreateClaim,
  insertTopicCreateAbortFence,
  TOPIC_CLAIM_ABORT_OWNER_PREFIX,
  type TopicCreateClaim,
  topicHasMessagesAfterClaim,
} from "#storage/topic-link-records";
import { deleteTopicCascade, TopicDeleteVetoedError } from "#topics/lifecycle";
import type { TopicDto } from "#types/api";

export type TopicCreateClaimAbortResult =
  /** No claim existed; an aborted fence now does. */
  | { kind: "fenced"; claim: TopicCreateClaim }
  /** Already aborted (idempotent). */
  | { kind: "already-aborted"; claim: TopicCreateClaim }
  /** Committed, but its topic was already gone: now aborted. */
  | { kind: "topic-missing"; claim: TopicCreateClaim }
  /** Committed, topic deleted, claim aborted — atomically. */
  | { kind: "deleted"; claim: TopicCreateClaim }
  /** The topic holds messages written after the claim; kept, claim committed. */
  | { kind: "has-messages"; claim: TopicCreateClaim }
  /** Manager/General/ownerless topic; kept, claim committed. */
  | { kind: "protected"; claim: TopicCreateClaim }
  /** Maintenance fence held elsewhere, or the delete failed; kept, claim committed. */
  | { kind: "busy"; claim: TopicCreateClaim; error?: unknown };

export interface AbortTopicCreateClaimOptions {
  /** Passed to the delete cascade (embedded hosts, deterministic tests). */
  purgeLogs?: typeof purgeTopicLogs;
  /** Test seam: runs before the deciding transaction opens. */
  beforeDecide?: () => void | Promise<void>;
  /** Test seam: runs after the fence committed, before the cascade starts. */
  afterFence?: (topicId: string) => void | Promise<void>;
}

function ownerOf(topic: TopicDto): string | null {
  return topic.participants.find((participant) => participant.role === "owner")?.userId ?? null;
}

type Decision =
  | Exclude<TopicCreateClaimAbortResult, { kind: "deleted" | "busy" }>
  | { kind: "busy"; claim: TopicCreateClaim }
  | {
      kind: "delete";
      claim: TopicCreateClaim;
      topic: TopicDto;
      owner: string;
      maintenance: RuntimeTopicMaintenanceHandle;
    };

function requireClaim(principalKey: string, requestId: string): TopicCreateClaim {
  const claim = getTopicCreateClaim(principalKey, requestId);
  if (!claim) throw new Error("topic create claim vanished during abort");
  return claim;
}

function decide(principalKey: string, requestId: string): Decision {
  return db
    .transaction((): Decision => {
      const claim = getTopicCreateClaim(principalKey, requestId);
      if (!claim) {
        insertTopicCreateAbortFence(principalKey, requestId);
        return { kind: "fenced", claim: requireClaim(principalKey, requestId) };
      }
      if (claim.state === "aborted") return { kind: "already-aborted", claim };
      const topic = claim.topicId ? getTopic(claim.topicId) : null;
      if (!topic) {
        flipCommittedTopicCreateClaimToAborted(principalKey, requestId);
        return { kind: "topic-missing", claim: requireClaim(principalKey, requestId) };
      }
      if (topicHasMessagesAfterClaim(claim)) return { kind: "has-messages", claim };
      const owner = ownerOf(topic);
      if (!owner || topic.kind === "manager" || topic.id === GENERAL_TOPIC_ID) {
        return { kind: "protected", claim };
      }
      const maintenance = beginRuntimeTopicMaintenance(topic.id, {
        ownerId: `${TOPIC_CLAIM_ABORT_OWNER_PREFIX}${process.pid}-${randomUUID()}`,
      });
      if (!maintenance) return { kind: "busy", claim };
      return { kind: "delete", claim, topic, owner, maintenance };
    })
    .immediate();
}

/** Abort one principal's create claim. See the module comment for the states. */
export async function abortTopicCreateClaim(
  principalKey: string,
  requestId: string,
  options: AbortTopicCreateClaimOptions = {},
): Promise<TopicCreateClaimAbortResult> {
  await options.beforeDecide?.();
  const decision = decide(principalKey, requestId);
  if (decision.kind !== "delete") return decision;
  const { claim, topic, owner, maintenance } = decision;
  let cascadeStarted = false;
  try {
    await options.afterFence?.(topic.id);
    cascadeStarted = true;
    await deleteTopicCascade(topic, owner, {
      maintenance,
      ...(options.purgeLogs ? { purgeLogs: options.purgeLogs } : {}),
      guard() {
        const current = getTopicCreateClaim(principalKey, requestId);
        if (current?.state !== "committed" || current.topicId !== topic.id) {
          throw new TopicDeleteVetoedError(topic.id, "the create claim changed");
        }
        if (topicHasMessagesAfterClaim(current)) {
          throw new TopicDeleteVetoedError(topic.id, "messages arrived after the claim");
        }
      },
      withinDeleteTransaction() {
        if (!flipCommittedTopicCreateClaimToAborted(principalKey, requestId)) {
          throw new TopicDeleteVetoedError(topic.id, "the create claim changed");
        }
      },
    });
  } catch (error) {
    if (!cascadeStarted) maintenance.finish();
    const current = getTopicCreateClaim(principalKey, requestId) ?? claim;
    if (error instanceof TopicDeleteVetoedError) {
      logger.warn(
        { requestId, topicId: topic.id, reason: error.message },
        "otium link: claim abort kept the topic",
      );
      return topicHasMessagesAfterClaim(current)
        ? { kind: "has-messages", claim: current }
        : { kind: "busy", claim: current, error };
    }
    logger.warn({ error, requestId, topicId: topic.id }, "otium link: claim abort delete failed");
    return { kind: "busy", claim: current, error };
  }
  const settled = requireClaim(principalKey, requestId);
  if (getTopic(topic.id) || settled.state !== "aborted") return { kind: "busy", claim: settled };
  return { kind: "deleted", claim: settled };
}
