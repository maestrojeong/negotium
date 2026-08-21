#!/usr/bin/env bun
/**
 * otium ↔ negotium coupling experiment — hub-side E2E driver.
 *
 * Rewritten for the Runtime Gateway / Dynamic Topic Mapping model
 * (docs/OTIUM-NODE-ARCHITECTURE.md D-1/D-6). The previous version of this
 * script drove the "placed-turn" flow — `POST /api/v1/agents` then
 * `PUT /api/v1/topics/:id/node` to force-place a hub room onto a worker,
 * which provisioned a hidden *mirror* topic there. That whole receiver was
 * deleted ("Placed-turn receiver retired", same doc) — `PUT .../node` is a
 * 404 today. There is exactly one data plane now: the node owns a topic, the
 * hub's `topic-sync` loop (15s poll) notices it and creates a mapped room
 * automatically, and everything after that runs over the Runtime Gateway
 * (`POST /topics`, `POST /turns`, `GET /events`) instead of the old
 * `/api/v1/peer/*` mirror routes.
 *
 * Prerequisites:
 *   1. bun scripts/otium-experiment/hub-setup.ts
 *   2. NEGOTIUM_STATE_DIR=/tmp/otium-experiment/worker-state \
 *      bun apps/cli/src/main.ts otium join <code> --legacy
 *      NEGOTIUM_STATE_DIR=/tmp/otium-experiment/worker-state \
 *      NEGOTIUM_NODE_PORT=<port from hub-setup.ts> \
 *      bun apps/cli/src/main.ts otium serve --port 7777
 *   3. bun scripts/otium-experiment/enable-gateway.ts
 *
 * This script then, as a hub user:
 *   - creates a topic directly on the negotium node's Runtime Gateway
 *     (`POST /topics` — always born on `surface: "otium"`, control.ts)
 *   - polls the hub's `GET /api/v1/topics` until topic-sync has mirrored it
 *     into a mapped room, and reports how long that discovery took
 *   - sends a message into the mapped hub room (`POST /messages`); a mapped
 *     topic executes the turn automatically via `submitTurn` — no separate
 *     `POST /ai` call, and `/ai` on a mapped topic now returns 409 by design
 *   - polls the hub room until the worker's "ai" reply is projected back,
 *     and reports that round trip too
 *
 * Env: PROMPT (default one-liner), AGENT (default claude),
 *      EXPERIMENT_DIR (default /tmp/otium-experiment),
 *      DISCOVERY_TIMEOUT_MS (default 30000), TURN_TIMEOUT_MS (default 180000)
 *
 * Not covered (left for a follow-up — see tmp/run-e2e-fix-plan.html §4.3):
 *   the old E2E_FEATURES=input,artifact,ask suite. Those subflows still
 *   assume placement (`createAgentRoom(..., placeOnWorker)`) and need the
 *   same rework as the base flow before they can run again.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const EXPERIMENT_DIR = resolve(process.env.EXPERIMENT_DIR ?? "/tmp/otium-experiment");
const STATE_FILE = join(EXPERIMENT_DIR, "state.json");
const AGENT = process.env.AGENT ?? "claude";
const PROMPT = process.env.PROMPT ?? "Reply with exactly one word: pong. Do not use any tools.";
const DISCOVERY_TIMEOUT_MS = Number(process.env.DISCOVERY_TIMEOUT_MS ?? 30_000);
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 180_000);

function die(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

if (!existsSync(STATE_FILE)) die(`no ${STATE_FILE} — run hub-setup.ts first`);
const state = (await Bun.file(STATE_FILE).json()) as {
  hubUrl: string;
  workerUrl: string;
  workerStateDir: string;
  adminKey: string;
  worker: { nodeName: string; nodePort: number };
};

const NODE_GATEWAY_URL = `http://127.0.0.1:${state.worker.nodePort}/api/v1/control/runtime/v1`;
const tokenPath = join(state.workerStateDir, "secrets", "node-control-token");
if (!existsSync(tokenPath)) {
  die(
    `${tokenPath} does not exist — has the worker Node started? ` +
      `(\`otium join\` + \`otium serve\` on the worker side)`,
  );
}
const nodeControlToken = readFileSync(tokenPath, "utf8").trim();

let jwt = "";

async function hub<T = Record<string, unknown>>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${state.hubUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as T };
}

async function node<T = Record<string, unknown>>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${NODE_GATEWAY_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${nodeControlToken}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as T };
}

function expectOk<T extends { ok?: boolean; error?: string }>(
  label: string,
  result: { status: number; body: T },
): T {
  if (result.status >= 400 || result.body?.ok === false) {
    die(`${label} failed (${result.status}): ${result.body?.error ?? "no error body"}`);
  }
  return result.body;
}

type HubTopic = { id: string; title: string };
type HubMessage = { authorId: string; text: string; createdAt: string };

function elapsedMs(since: number): number {
  return Date.now() - since;
}

// ── 0. worker + node reachable? ───────────────────────────────────────

console.log(`\n[0/5] probing worker ${state.workerUrl}/ready and the node Gateway`);
try {
  const ready = await fetch(`${state.workerUrl}/ready`, { signal: AbortSignal.timeout(3000) });
  const body = (await ready.json()) as { ok?: boolean };
  if (!body.ok) throw new Error("not ok");
} catch {
  die(`worker is not answering /ready — did you run \`otium join\` + \`otium serve\`?`);
}
expectOk("GET node /health", await node<{ ok: boolean; error?: string }>("/health"));

// ── 1. hub login ─────────────────────────────────────────────────────

console.log("[1/5] logging into the hub with ADMIN_KEY");
{
  const result = await hub<{ jwt?: string; error?: string }>("/api/v1/auth/verify", {
    method: "POST",
    body: JSON.stringify({ code: state.adminKey, name: "Operator" }),
  });
  if (!result.body?.jwt) {
    die(
      `hub login failed (${result.status}): ${result.body?.error}\n` +
        `Did you run enable-gateway.ts? It restarts hub-runtime-api, which needs a moment to come back.`,
    );
  }
  jwt = result.body.jwt;
}

// ── 2. create a topic directly on the node's Runtime Gateway ─────────

const title = `gw-bench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
console.log(`[2/5] creating topic "${title}" (${AGENT}) on the node via the Gateway`);
const created = expectOk(
  "POST node /topics",
  await node<{ ok: boolean; error?: string; topic?: { id: string } }>("/topics", {
    method: "POST",
    body: JSON.stringify({ v: 1, userId: "local", title, agent: AGENT }),
  }),
);
const negotiumTopicId = created.topic?.id ?? "";
if (!negotiumTopicId) die("node topic create returned no id");
console.log(`  node topic ${negotiumTopicId} created (surface: otium, per control.ts)`);

// ── 3. wait for the hub's topic-sync loop to mirror it ────────────────

console.log(
  `[3/5] waiting for the hub to discover it via topic-sync (≤${DISCOVERY_TIMEOUT_MS / 1000}s, polls every 15s)`,
);
const discoveryStart = Date.now();
let hubTopicId = "";
{
  const deadline = discoveryStart + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline && !hubTopicId) {
    const list = await hub<{ ok: boolean; data?: HubTopic[] }>("/api/v1/topics");
    const match = (list.body?.data ?? []).find((topic) => topic.title === title);
    if (match) {
      hubTopicId = match.id;
      break;
    }
    await Bun.sleep(1000);
  }
}
if (!hubTopicId) {
  die(
    `hub never mirrored a room titled "${title}" within ${DISCOVERY_TIMEOUT_MS / 1000}s.\n` +
      `Check ${EXPERIMENT_DIR}/hub-runtime-api.log for OTIUM_NEGOTIUM_GATEWAY_* readiness errors ` +
      `(did enable-gateway.ts run after the worker was up?).`,
  );
}
const discoveryMs = elapsedMs(discoveryStart);
console.log(`  mirrored as hub room ${hubTopicId} — discovery took ${discoveryMs}ms`);

// ── 4. send a message; a mapped topic runs the turn automatically ────

console.log(`[4/5] sending message: ${JSON.stringify(PROMPT)}`);
const turnStart = Date.now();
const dispatch = expectOk(
  "POST /messages",
  await hub<{ ok: boolean; error?: string; data?: { negotiumAccepted?: boolean } }>(
    `/api/v1/topics/${hubTopicId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ text: PROMPT, clientMessageId: crypto.randomUUID() }),
    },
  ),
);
if (!dispatch.data?.negotiumAccepted) {
  die(
    "message was accepted locally instead of being forwarded to negotium — " +
      "the topic is not actually mapped/executable (check OTIUM_NEGOTIUM_GATEWAY_EXECUTION_ENABLED)",
  );
}
console.log("  accepted by the node via submitTurn (POST /turns under the hood)");

// ── 5. wait for the answer to flow back to the hub ────────────────────

console.log(`[5/5] waiting for the worker's reply (≤${TURN_TIMEOUT_MS / 1000}s)`);
let answer: HubMessage | null = null;
{
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline && !answer) {
    const messages = await hub<{ ok: boolean; data?: HubMessage[] }>(
      `/api/v1/topics/${hubTopicId}/messages`,
    );
    const list = Array.isArray(messages.body?.data) ? messages.body.data : [];
    answer =
      list.find(
        (message) =>
          message.authorId === "ai" && new Date(message.createdAt).getTime() >= turnStart,
      ) ?? null;
    if (!answer) await Bun.sleep(500);
  }
}
if (!answer) {
  die(
    `no "ai" reply arrived within ${TURN_TIMEOUT_MS / 1000}s.\n` +
      `Check the worker log and ${EXPERIMENT_DIR}/hub-runtime-api.log`,
  );
}
const turnMs = elapsedMs(turnStart);

console.log("\n──────────────────────────────────────────────────────────────");
console.log("E2E OK — Runtime Gateway round trip, hub ↔ negotium:");
console.log(`  node topic:      ${negotiumTopicId}`);
console.log(`  hub room:        ${title} (${hubTopicId})`);
console.log(`  discovery time:  ${discoveryMs}ms (topic-sync poll, up to 15s by design)`);
console.log(`  turn round trip: ${turnMs}ms (submitTurn ack + real agent turn + projection back)`);
console.log(`  answer:          ${answer.text.slice(0, 200)}`);
console.log("──────────────────────────────────────────────────────────────");
