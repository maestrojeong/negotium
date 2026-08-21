import { claimPeerInboxRequestWithDelivery, peerInboxPayloadHash } from "@/store";

const [requestId, topicId] = process.argv.slice(2);
if (!requestId || !topicId) throw new Error("requestId and topicId are required");
const payload = { message: requestId };
const result = claimPeerInboxRequestWithDelivery({
  fromCellId: "concurrent-hub-cell",
  requestId,
  kind: "tell",
  topicId,
  payloadHash: peerInboxPayloadHash(payload),
  userId: "owner",
  entry: { type: "tell", requestId, from: "hub/source", message: requestId, depth: 0 },
});
process.stdout.write(result.outcome);
