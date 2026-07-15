#!/usr/bin/env bun
/**
 * otium ↔ negotium coupling experiment — hub-side E2E driver
 * (docs/OTIUM-COUPLING.md §5.4). Prerequisites:
 *
 *   1. bun scripts/otium-experiment/hub-setup.ts      (central + hub running)
 *   2. export NEGOTIUM_STATE_DIR=/tmp/otium-experiment/worker-state
 *      bun apps/cli/src/main.ts otium join <code>
 *      bun apps/cli/src/main.ts otium serve --port 7777
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
 *      EXPERIMENT_DIR (default /tmp/otium-experiment),
 *      E2E_FEATURES (comma list: input,artifact,ask; or all)
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const EXPERIMENT_DIR = resolve(process.env.EXPERIMENT_DIR ?? "/tmp/otium-experiment");
const STATE_FILE = join(EXPERIMENT_DIR, "state.json");
const AGENT = process.env.AGENT ?? "claude";
const PROMPT = process.env.PROMPT ?? "Reply with exactly one word: pong. Do not use any tools.";
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 180_000);
const requestedFeatures = new Set(
  (process.env.E2E_FEATURES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const featureEnabled = (name: string) =>
  requestedFeatures.has("all") || requestedFeatures.has(name);

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

async function hubForm<T = Record<string, unknown>>(
  path: string,
  form: FormData,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${state.hubUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body: form,
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

type HubMessage = {
  authorId: string;
  text: string;
  queryId?: string;
  attachments?: Array<{ id: string; filename: string; url: string }>;
};

async function createAgentRoom(
  prefix: string,
  placeOnWorker: boolean,
): Promise<{
  topicId: string;
  title: string;
}> {
  const title = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const created = expectOk(
    `create ${prefix} room`,
    await hub<{ ok: boolean; error?: string; data?: { id: string } }>("/api/v1/agents", {
      method: "POST",
      body: JSON.stringify({ title, agent: AGENT }),
    }),
  );
  const topicId = created.data?.id ?? "";
  if (!topicId) die(`${prefix} room create returned no id`);
  if (placeOnWorker) {
    expectOk(
      `place ${prefix} room`,
      await hub<{ ok: boolean; error?: string }>(`/api/v1/topics/${topicId}/node`, {
        method: "PUT",
        body: JSON.stringify({ nodeName: state.worker.nodeName }),
      }),
    );
  }
  return { topicId, title };
}

async function topicMessages(topicId: string): Promise<HubMessage[]> {
  const result = await hub<{ ok: boolean; data?: HubMessage[] }>(
    `/api/v1/topics/${topicId}/messages`,
  );
  return Array.isArray(result.body?.data) ? result.body.data : [];
}

async function dispatchTurn(
  topicId: string,
  prompt: string,
  attachments: string[] = [],
): Promise<string> {
  expectOk(
    "POST /messages",
    await hub<{ ok: boolean; error?: string }>(`/api/v1/topics/${topicId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: prompt, ...(attachments.length ? { attachments } : {}) }),
    }),
  );
  const dispatched = expectOk(
    "POST /ai",
    await hub<{ ok: boolean; error?: string; data?: { queryId: string } }>(
      `/api/v1/topics/${topicId}/ai`,
      {
        method: "POST",
        body: JSON.stringify({ text: prompt, ...(attachments.length ? { attachments } : {}) }),
      },
    ),
  );
  const requestId = dispatched.data?.queryId ?? "";
  if (!requestId.startsWith("pt-")) die(`expected peer requestId, got ${requestId}`);
  return requestId;
}

async function waitForMessage(
  topicId: string,
  predicate: (message: HubMessage) => boolean,
  label: string,
): Promise<HubMessage> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = (await topicMessages(topicId)).find(predicate);
    if (found) return found;
    await Bun.sleep(1500);
  }
  die(`${label} did not appear within ${TURN_TIMEOUT_MS / 1000}s`);
}

async function waitForVisual(topicId: string, title: string, kind: string): Promise<void> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const visuals = await hub<{
      ok: boolean;
      data?: { visuals?: Array<{ title?: string; kind?: string }> };
    }>(`/api/v1/topics/${topicId}/visual`);
    const found =
      visuals.body.data?.visuals?.some(
        (visual) => visual.title === title && visual.kind === kind,
      ) ?? false;
    if (found) return;
    await Bun.sleep(1000);
  }
  die(`hub-owned ${kind} visual ${JSON.stringify(title)} was not stored`);
}

async function topicVisuals(topicId: string): Promise<Array<{ title?: string; kind?: string }>> {
  const visuals = await hub<{
    ok: boolean;
    data?: { visuals?: Array<{ title?: string; kind?: string }> };
  }>(`/api/v1/topics/${topicId}/visual`);
  return visuals.body.data?.visuals ?? [];
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
let hubNodeName = "";
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
  hubNodeName = nodes.data?.nodes.find((node) => node.self)?.nodeName ?? "";
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
  "\nOptional feature suite: E2E_FEATURES=input,artifact,ask bun scripts/otium-experiment/run-e2e.ts",
);

// ── Optional feature-level cross-process checks ─────────────────────

if (featureEnabled("input")) {
  const marker = `INPUT_OK_${Date.now().toString(36)}`;
  console.log(`\n[feature:input] uploading and reading attachment marker ${marker}`);
  const form = new FormData();
  form.set(
    "file",
    new File([`attachment marker: ${marker}\n`], "peer-input.txt", { type: "text/plain" }),
  );
  const uploaded = expectOk(
    "POST /api/v1/upload",
    await hubForm<{
      ok: boolean;
      error?: string;
      data?: { fileId: string };
    }>("/api/v1/upload", form),
  );
  const fileId = uploaded.data?.fileId ?? "";
  if (!fileId) die("upload returned no fileId");
  const room = await createAgentRoom("placed-input", true);
  const requestId = await dispatchTurn(
    room.topicId,
    "Read the attached text file and reply with only the marker after `attachment marker:`.",
    [fileId],
  );
  const answer = await waitForMessage(
    room.topicId,
    (message) => message.authorId === "ai" && message.queryId === requestId,
    "input-file answer",
  );
  if (!answer.text.includes(marker)) die(`input marker missing from answer: ${answer.text}`);
  console.log("  input attachment copied to worker and read successfully");
}

if (featureEnabled("artifact")) {
  const marker = `ARTIFACT_OK_${Date.now().toString(36)}`;
  const htmlTitle = `Peer HTML ${marker}`;
  const mermaidTitle = `Peer Mermaid ${marker}`;
  const imageTitle = `Peer Image ${marker}`;
  const videoTitle = `Peer Video ${marker}`;
  console.log(`\n[feature:artifact] bridging files + all visual kinds marker ${marker}`);
  const room = await createAgentRoom("placed-artifact", true);
  const requestId = await dispatchTurn(
    room.topicId,
    [
      `Create a file named peer-output.txt in the current workspace containing exactly ${marker}.`,
      "Call the runtime send_file tool with that file's absolute path.",
      `Call show_html with title ${JSON.stringify(htmlTitle)} and HTML containing ${marker}.`,
      `Call show_mermaid with title ${JSON.stringify(mermaidTitle)} and code ` +
        `graph TD; A[${marker}] --> B[done].`,
      "Create peer-image.png by base64-decoding " +
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=.",
      `Call show_image for peer-image.png with title ${JSON.stringify(imageTitle)}.`,
      "Create peer-video.mp4 containing the bytes peer-video-placeholder.",
      `Call show_video for peer-video.mp4 with title ${JSON.stringify(videoTitle)}.`,
      `After all five tools succeed, reply with exactly ${marker}.`,
    ].join(" "),
  );
  await waitForMessage(
    room.topicId,
    (message) => message.authorId === "ai" && message.queryId === requestId,
    "artifact turn answer",
  );
  const attachmentMessage = await waitForMessage(
    room.topicId,
    (message) =>
      message.attachments?.some((attachment) => attachment.filename === "peer-output.txt") === true,
    "bridged output attachment",
  );
  const attachment = attachmentMessage.attachments?.find(
    (entry) => entry.filename === "peer-output.txt",
  );
  if (!attachment) die("bridged output attachment metadata missing");
  const downloaded = await fetch(`${state.hubUrl}${attachment.url}`, {
    headers: { authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(30_000),
  });
  const bytes = await downloaded.text();
  if (!downloaded.ok || bytes.trim() !== marker) {
    die(`bridged output bytes mismatch (${downloaded.status}): ${JSON.stringify(bytes)}`);
  }

  await Promise.all([
    waitForVisual(room.topicId, htmlTitle, "html"),
    waitForVisual(room.topicId, mermaidTitle, "mermaid"),
    waitForVisual(room.topicId, imageTitle, "image"),
    waitForVisual(room.topicId, videoTitle, "video"),
  ]);
  const allMessages = await topicMessages(room.topicId);
  const outputCopies = allMessages
    .flatMap((message) => message.attachments ?? [])
    .filter((entry) => entry.filename === "peer-output.txt");
  if (outputCopies.length !== 1) {
    die(`expected exactly one bridged output attachment, found ${outputCopies.length}`);
  }
  const allVisuals = await topicVisuals(room.topicId);
  for (const [title, kind] of [
    [htmlTitle, "html"],
    [mermaidTitle, "mermaid"],
    [imageTitle, "image"],
    [videoTitle, "video"],
  ] as const) {
    const copies = allVisuals.filter((visual) => visual.title === title && visual.kind === kind);
    if (copies.length !== 1) die(`expected exactly one ${kind} visual, found ${copies.length}`);
  }
  console.log("  output bytes and all four visual kinds are hub-owned and unique");
}

if (featureEnabled("ask")) {
  if (!hubNodeName) die("hub node has no nodeName; remote ask target cannot be addressed");
  const marker = `ASK_OK_${Date.now().toString(36)}`;
  console.log(`\n[feature:ask] worker ask_session → hub → worker reply marker ${marker}`);
  const target = await createAgentRoom("hub-ask-target", false);
  const caller = await createAgentRoom("placed-ask-caller", true);
  await dispatchTurn(
    caller.topicId,
    [
      `Call ask_session with target ${JSON.stringify(`${hubNodeName}/${target.title}`)}.`,
      `Ask it to reply with exactly ${marker}.`,
      `When the reply is injected, reply with exactly ${marker}.`,
    ].join(" "),
  );
  await waitForMessage(
    caller.topicId,
    (message) => message.authorId === "ai" && message.text.includes(marker),
    "remote ask reply in placed caller",
  );
  console.log("  remote ask reply returned to the canonical hub room");
}
