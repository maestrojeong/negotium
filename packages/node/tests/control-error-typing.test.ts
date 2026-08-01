import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { NODE_CONTROL_TOKEN, registerTopic } from "@negotium/core";
import { createNodeControlHandler, NODE_CONTROL_BASE_PATH } from "../src/control";

const userId = `control-errors-${randomUUID()}`;

/** Shaped like the internals an unexpected throw tends to carry. */
const LEAKY_MESSAGE = "ENOENT: /Users/private/.negotium/data/store.db is locked by pid 4242";

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:43211${NODE_CONTROL_BASE_PATH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${NODE_CONTROL_TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

const baseOptions = {
  port: () => 43211,
  startedAt: "2026-07-14T00:00:00.000Z",
  requestShutdown() {},
};

test("an unclassified error becomes a sanitized 500, not a 400 echoing internals", async () => {
  const handler = createNodeControlHandler({
    ...baseOptions,
    compactSession: () => {
      throw new Error(LEAKY_MESSAGE);
    },
  });
  const topic = registerTopic({ title: `Compact boom ${randomUUID()}`, userId });

  const response = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/session/compact`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  );

  // Previously this returned 400 with `error.message` verbatim: an internal
  // fault misreported as a client mistake, with the raw detail attached.
  expect(response?.status).toBe(500);
  const body = (await response?.json()) as { ok: boolean; error: string };
  expect(body.ok).toBeFalse();
  expect(body.error).toBe("Internal control-plane error");
  expect(body.error).not.toInclude("ENOENT");
  expect(body.error).not.toInclude("private");
  expect(body.error).not.toInclude("4242");
});

test("genuine request validation still answers 400 with an actionable message", async () => {
  const handler = createNodeControlHandler(baseOptions);
  const topic = registerTopic({ title: `Validation ${randomUUID()}`, userId });

  // `userId` missing entirely — a real client mistake, routed through the
  // typed ControlRequestError rather than the catch-all.
  const missingUser = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    }),
  );
  expect(missingUser?.status).toBe(400);
  expect(((await missingUser?.json()) as { error: string }).error).toBe("userId is required");

  // Present but blank counts as absent.
  const blankText = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ userId, text: "   " }),
    }),
  );
  expect(blankText?.status).toBe(400);
  expect(((await blankText?.json()) as { error: string }).error).toBe("text is required");
});

test("a non-string field is a 400, not a 500", async () => {
  const handler = createNodeControlHandler(baseOptions);
  const topic = registerTopic({ title: `Wrong type ${randomUUID()}`, userId });

  const response = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/model`, {
      method: "POST",
      body: JSON.stringify({ userId, model: 42 }),
    }),
  );

  expect(response?.status).toBe(400);
  expect(((await response?.json()) as { error: string }).error).toBe("model is required");
});

test("a missing idempotency key is a 400, not a 409 conflict", async () => {
  const handler = createNodeControlHandler(baseOptions);
  const topic = registerTopic({ title: `Idempotency ${randomUUID()}`, userId });

  // `requiredText(body.clientMessageId, "clientMessageId")` throws a message
  // containing "clientMessageId". The catch block used to sniff for that
  // substring and answer 409 before the typed check ran, reporting a malformed
  // request as a conflict.
  const response = await handler(
    request("/runtime/v1/turns", {
      method: "POST",
      body: JSON.stringify({ v: 1, topicId: topic.id, userId, text: "hi" }),
    }),
  );

  expect(response?.status).toBe(400);
  expect(((await response?.json()) as { error: string }).error).toBe("clientMessageId is required");
});

test("a genuine idempotency conflict is still a 409", async () => {
  const handler = createNodeControlHandler(baseOptions);
  const first = registerTopic({ title: `Conflict A ${randomUUID()}`, userId });
  const second = registerTopic({ title: `Conflict B ${randomUUID()}`, userId });
  const clientMessageId = randomUUID();

  const accepted = await handler(
    request("/runtime/v1/turns", {
      method: "POST",
      body: JSON.stringify({ v: 1, topicId: first.id, userId, text: "one", clientMessageId }),
    }),
  );
  expect(accepted?.status).toBe(202); // accepted for durable execution

  // Same idempotency key, different topic: the key is already bound elsewhere.
  // This path used to be reached only by sniffing the error message; it now
  // depends on RuntimeGatewayIdempotencyConflictError, so it needs coverage.
  const conflict = await handler(
    request("/runtime/v1/turns", {
      method: "POST",
      body: JSON.stringify({ v: 1, topicId: second.id, userId, text: "two", clientMessageId }),
    }),
  );
  expect(conflict?.status).toBe(409);
  expect(((await conflict?.json()) as { error: string }).error).toInclude("already bound");

  // The accepted submission enqueued a durable turn request. Those rows are
  // global: `claimNextRuntimeUserTurnRequest` in the storage suite picks the
  // next pending row regardless of topic, so leaving one behind makes an
  // unrelated test claim ours. Abort through the public route to clear it.
  for (const id of [first.id, second.id]) {
    await handler(
      request(`/topics/${encodeURIComponent(id)}/abort`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      }),
    );
  }
});

test("malformed percent encoding is a 400, not an internal 500", async () => {
  const handler = createNodeControlHandler(baseOptions);

  // `decodeURIComponent("%")` throws URIError. The catch-all classified that as
  // an unclassified fault and answered 500, blaming the node for bad input.
  const response = await handler(
    new Request(`http://127.0.0.1:43211${NODE_CONTROL_BASE_PATH}/topics/%/messages?user=u`, {
      headers: { authorization: `Bearer ${NODE_CONTROL_TOKEN}` },
    }),
  );

  expect(response?.status).toBe(400);
  expect(((await response?.json()) as { error: string }).error).toBe("Malformed URL encoding");
});
