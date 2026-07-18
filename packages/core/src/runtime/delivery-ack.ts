/**
 * Cross-process delivery acknowledgements for files rendered by an external
 * channel adapter. Signals ride the durable RuntimeBus so the runtime MCP and
 * adapter may live in separate processes (the default CLI topology).
 */

import { runtimeBus } from "#bus";

export interface DeliveryAckResult {
  ok: boolean;
  error?: string;
}

interface DeliveryAckSignal {
  kind: "delivery_ack";
  messageId: string;
  phase: "claimed" | "settled";
  result?: DeliveryAckResult;
}

export interface DeliveryAckWaiter {
  promise: Promise<DeliveryAckResult | null>;
  cancel(): void;
}

function signalForMessage(payload: unknown, messageId: string): DeliveryAckSignal | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Partial<DeliveryAckSignal>;
  if (
    value.kind !== "delivery_ack" ||
    value.messageId !== messageId ||
    (value.phase !== "claimed" && value.phase !== "settled")
  ) {
    return null;
  }
  return value as DeliveryAckSignal;
}

/**
 * Install the listener before publishing the attachment message. If no
 * adapter claims the message within `claimTimeoutMs`, no external delivery
 * surface was interested and the caller may keep the host-storage result.
 * Once claimed, lack of a final result is a delivery failure, never success.
 */
export function prepareDeliveryAck(
  messageId: string,
  claimTimeoutMs: number,
  deliveryTimeoutMs: number,
): DeliveryAckWaiter {
  let settled = false;
  let claimed = false;
  let finishPromise: (result: DeliveryAckResult | null) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};

  const promise = new Promise<DeliveryAckResult | null>((resolve) => {
    finishPromise = resolve;
  });

  unsubscribe = runtimeBus().subscribe((event) => {
    if (event.type !== "ai-status") return;
    const signal = signalForMessage(event.payload, messageId);
    if (!signal) return;
    if (signal.phase === "claimed") {
      if (claimed || settled) return;
      claimed = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        finish({ ok: false, error: "channel delivery confirmation timed out" });
      }, deliveryTimeoutMs);
      timer.unref?.();
      return;
    }
    if (signal.result) finish(signal.result);
  });

  function finish(result: DeliveryAckResult | null): void {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
    finishPromise(result);
  }

  timer = setTimeout(() => finish(null), claimTimeoutMs);
  timer.unref?.();

  return { promise, cancel: () => finish(null) };
}

/** Announce that an adapter accepted this message for external delivery. */
export function claimDeliveryAck(topicId: string, messageId: string): void {
  runtimeBus().broadcastAiStatus(topicId, {
    kind: "delivery_ack",
    messageId,
    phase: "claimed",
  } satisfies DeliveryAckSignal);
}

/** Publish the adapter's one aggregated result for this message. */
export function resolveDeliveryAck(
  topicId: string,
  messageId: string,
  result: DeliveryAckResult,
): void {
  runtimeBus().broadcastAiStatus(topicId, {
    kind: "delivery_ack",
    messageId,
    phase: "settled",
    result,
  } satisfies DeliveryAckSignal);
}
