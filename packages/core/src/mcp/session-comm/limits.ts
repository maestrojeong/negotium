/**
 * Largest message a remote (`node/topic`) tell/ask may carry, in characters.
 * The same value as the adapter's `MAX_PEER_MESSAGE_LENGTH` (`protocol.ts`)
 * and the local `MAX_MESSAGE_LENGTH`, so a message accepted locally is never
 * refused only because it crossed a node boundary. Enforced by the hub on
 * the way in and by the node's inbox route on the way out.
 */
export const MAX_PEER_MESSAGE_LENGTH = 10_000;
