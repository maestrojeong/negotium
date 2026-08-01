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
