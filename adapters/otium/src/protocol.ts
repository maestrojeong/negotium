/**
 * otium peer protocol — payload shapes exchanged between workspace runtime
 * nodes. Field-for-field copy of otium's
 * `apps/runtime-api/src/peer/protocol.ts` (PEER_PROTOCOL_VERSION 1): the hub
 * trusts these shapes without schema validation, so this file must track the
 * otium side exactly.
 *
 * What remains is the cross-node *session* surface (tell / ask / sessions /
 * reply / abort-by-title). The placed-turn wire types — `PeerTurnRequest`,
 * `PeerProvisionRequest`, `PeerEventRequest` and `PlacedTopicExecutionSpec` —
 * went with the placement receiver; the Runtime Gateway at
 * `/api/v1/peer/runtime/*` carries hub-driven execution now, and it speaks the
 * canonical node control protocol rather than a hand-copied peer shape.
 */

export const PEER_PROTOCOL_VERSION = 1;

export const MAX_PEER_MESSAGE_LENGTH = 10_000;

/**
 * Body-size ceiling for the public peer surface — the sidecar listener and the
 * canonical node when `negotium otium serve` mounts the adapter.
 *
 * It was sized for `/api/v1/peer/input-file`, which staged a placed turn's
 * attachments. That route is gone, but the limit is not about it: hub→worker
 * file uploads now ride the Runtime Gateway forward across the same listener, so
 * shrinking this would cap them instead.
 */
export const MAX_PEER_REQUEST_BODY_BYTES = 2 * 1024 * 1024 * 1024 + 8 * 1024 * 1024;

export interface PeerSessionEntry {
  topicId: string;
  name: string;
  agent: string | null;
  hasSession: boolean;
  description?: string;
}
