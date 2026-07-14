#!/usr/bin/env bun
/**
 * otium ↔ negotium coupling experiment — hub-side E2E driver
 * (docs/OTIUM-COUPLING.md §5.4). Prerequisites:
 *
 *   1. bun scripts/otium-experiment/hub-setup.ts      (central + hub running)
 *   2. negotium otium join <code>  &&  negotium otium serve (worker on :7777)
 *
 * This script then, as a hub user:
 *   - checks the node picker sees "nego" ready
 *   - creates a fresh agent room (placement requires no native session yet)
 *   - places it on "nego" (PUT /topics/:id/node → /ready → /capabilities →
 *     /provision on the worker)
 *   - sends one message (POST /messages + POST /ai → peer turn dispatch)
 *   - polls the hub room until the worker's ai message + terminal arrive back
 *
 * Env: PROMPT (default one-liner), AGENT (default claude),
 *      EXPERIMENT_DIR (default /tmp/otium-experiment)
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const EXPERIMENT_DIR = resolve(process.env.EXPERIMENT_DIR ?? "/tmp/otium-experiment");
const STATE_FILE = join(EXPERIMENT_DIR, "state.json");
const AGENT = process.env.AGENT ?? "claude";
const PROMPT = process.env.PROMPT ?? "Reply with exactly one word: pong. Do not use any tools.";
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 180_000);

function die(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

if (!existsSync(STATE_FILE)) die(`no ${STATE_FILE} — run hub-setup.ts first`);
const state = (await Bun.file(STATE_FILE).json()) as {
  hubUrl: string;
  workerUrl: string;
  adminKey: string;
  worker: { nodeName: string };
};

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

function expectOk<T extends { ok?: boolean; error?: string }>(
  label: string,
  result: { status: number; body: T },
): T {
  if (result.status >= 400 || result.body?.ok === false) {
    die(`${label} failed (${result.status}): ${result.body?.error ?? "no error body"}`);
  }
  return result.body;
}

// ── 0. worker reachable? ─────────────────────────────────────────────

console.log(`\n[0/5] probing worker ${state.workerUrl}/ready`);
try {
  const ready = await fetch(`${state.workerUrl}/ready`, { signal: AbortSignal.timeout(3000) });
  const body = (await ready.json()) as { ok?: boolean };
  if (!body.ok) throw new Error("not ok");
} catch {
  die(
    `worker is not answering /ready — did you run \`negotium otium join <code>\` + \`negotium otium serve\`?`,
  );
}

// ── 1. hub login ─────────────────────────────────────────────────────

console.log("[1/5] logging into the hub with ADMIN_KEY");
{
  const result = await hub<{ jwt?: string; error?: string }>("/api/v1/auth/verify", {
    method: "POST",
    body: JSON.stringify({ code: state.adminKey, name: "Operator" }),
  });
  if (!result.body?.jwt) die(`hub login failed (${result.status}): ${result.body?.error}`);
  jwt = result.body.jwt;
}

// ── 2. node picker sees the worker ───────────────────────────────────

console.log("[2/5] checking the workspace node list");
{
  const nodes = expectOk(
    "GET /api/v1/peer/workspace-nodes",
    await hub<{
      ok: boolean;
      error?: string;
      data?: { nodes: Array<{ nodeName: string | null; ready?: boolean; self?: boolean }> };
    }>("/api/v1/peer/workspace-nodes"),
  );
  const worker = nodes.data?.nodes.find((node) => node.nodeName === state.worker.nodeName);
  if (!worker) die(`node "${state.worker.nodeName}" is not in the workspace node list`);
  if (!worker.ready) die(`node "${state.worker.nodeName}" is attached but not ready`);
  console.log(`  node "${state.worker.nodeName}" is ready`);
}

// ── 3. fresh agent room, placed on the worker ────────────────────────

const title = `placed-${Date.now().toString(36)}`;
console.log(`[3/5] creating agent room "${title}" (${AGENT}) and placing it on "nego"`);
const topic = expectOk(
  "POST /api/v1/agents",
  await hub<{ ok: boolean; error?: string; data?: { id: string } }>("/api/v1/agents", {
    method: "POST",
    body: JSON.stringify({ title, agent: AGENT }),
  }),
);
const topicId = topic.data?.id ?? "";
if (!topicId) die("topic create returned no id");

expectOk(
  "PUT /api/v1/topics/:id/node",
  await hub<{ ok: boolean; error?: string }>(`/api/v1/topics/${topicId}/node`, {
    method: "PUT",
    body: JSON.stringify({ nodeName: state.worker.nodeName }),
  }),
);
console.log("  placement + worker provision OK (hidden mirror room exists on negotium)");

// ── 4. send a message → peer turn ────────────────────────────────────

console.log(`[4/5] sending message: ${JSON.stringify(PROMPT)}`);
expectOk(
  "POST /messages",
  await hub<{ ok: boolean; error?: string }>(`/api/v1/topics/${topicId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: PROMPT }),
  }),
);
const dispatched = expectOk(
  "POST /ai",
  await hub<{ ok: boolean; error?: string; data?: { queryId: string } }>(
    `/api/v1/topics/${topicId}/ai`,
    { method: "POST", body: JSON.stringify({ text: PROMPT }) },
  ),
);
const requestId = dispatched.data?.queryId ?? "";
console.log(`  dispatched — requestId (hub queryId) = ${requestId}`);
if (!requestId.startsWith("pt-")) {
  die(
    `queryId ${requestId} is not a peer requestId (pt-…) — the room did not run on the worker node`,
  );
}

// ── 5. wait for the answer to flow back hub-side ─────────────────────

console.log(
  `[5/5] waiting for the worker's ai message to appear on the hub (≤${TURN_TIMEOUT_MS / 1000}s)`,
);
const deadline = Date.now() + TURN_TIMEOUT_MS;
let answer: { text: string } | null = null;
while (Date.now() < deadline && !answer) {
  const messages = await hub<{
    ok: boolean;
    data?: Array<{ authorId: string; text: string; queryId?: string }>;
  }>(`/api/v1/topics/${topicId}/messages`);
  const list = Array.isArray(messages.body?.data) ? messages.body.data : [];
  answer =
    list.find((message) => message.authorId === "ai" && message.queryId === requestId) ?? null;
  if (!answer) await new Promise((resolveSleep) => setTimeout(resolveSleep, 2000));
}
if (!answer) {
  die(
    `no ai message with queryId=${requestId} arrived within ${TURN_TIMEOUT_MS / 1000}s.\n` +
      `Check the worker log (negotium otium serve) and ${EXPERIMENT_DIR}/hub-runtime-api.log`,
  );
}

console.log("\n──────────────────────────────────────────────────────────────");
console.log("E2E OK — the turn ran on negotium and flowed back to the hub:");
console.log(`  room:      ${title} (${topicId})`);
console.log(`  requestId: ${requestId}`);
console.log(`  answer:    ${answer.text.slice(0, 200)}`);
console.log("──────────────────────────────────────────────────────────────");
console.log(
  "\nOptional follow-ups (scripts/otium-experiment/README.md): abort mid-turn, tell_session nego/<room>, hub restart behavior.",
);
