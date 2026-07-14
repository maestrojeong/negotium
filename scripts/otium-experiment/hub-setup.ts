#!/usr/bin/env bun
/**
 * otium ↔ negotium coupling experiment — hub-side bootstrap (v0, zero
 * otium-copy changes). Implements docs/OTIUM-COUPLING.md §5.2–5.3:
 *
 *   1. boot otium-copy central-api (port 4600, fresh state dir)
 *   2. admin login via the dev email-code flow (EMAIL_MODE=dev returns the code)
 *   3. create a workspace
 *   4. register the HUB runtime cell with a direct baseUrl (no relay) and
 *      assign it as the workspace primary
 *   5. boot otium-copy runtime-api as the hub (port 4000, OTIUM_MULTI_NODE=1)
 *   6. register the WORKER cell (direct baseUrl http://127.0.0.1:7777) and
 *      attach it as worker "nego"
 *   7. print the invite code = base64url(JSON {v, central, cellId, secret})
 *
 * Both servers keep running in the background (logs + PIDs under
 * $EXPERIMENT_DIR). State needed by run-e2e.ts is saved to state.json.
 *
 * Usage:
 *   bun scripts/otium-experiment/hub-setup.ts
 * Env overrides:
 *   OTIUM_COPY_DIR   (default: ~/otium-copy)
 *   EXPERIMENT_DIR   (default: /tmp/otium-experiment)
 *   ADMIN_EMAIL      (default: yeonwoo.jeong@bluehole.net)
 *   CENTRAL_PORT / HUB_PORT / WORKER_PORT (default: 4600 / 4000 / 7777)
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const OTIUM_COPY_DIR = resolve(process.env.OTIUM_COPY_DIR ?? join(homedir(), "otium-copy"));
const EXPERIMENT_DIR = resolve(process.env.EXPERIMENT_DIR ?? "/tmp/otium-experiment");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "yeonwoo.jeong@bluehole.net";
const CENTRAL_PORT = Number(process.env.CENTRAL_PORT ?? 4600);
const HUB_PORT = Number(process.env.HUB_PORT ?? 4000);
const WORKER_PORT = Number(process.env.WORKER_PORT ?? 7777);

const CENTRAL_URL = `http://127.0.0.1:${CENTRAL_PORT}`;
const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
const STATE_FILE = join(EXPERIMENT_DIR, "state.json");

function die(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

async function waitForHttp(url: string, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.status < 500) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
  }
  die(`${label} did not come up at ${url} within ${timeoutMs / 1000}s`);
}

function spawnDetached(opts: {
  label: string;
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}): number {
  const logPath = join(EXPERIMENT_DIR, `${opts.label}.log`);
  const fd = openSync(logPath, "a");
  const proc = Bun.spawn(opts.cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: fd,
    stderr: fd,
    stdin: "ignore",
  });
  proc.unref();
  console.log(`  started ${opts.label} (pid ${proc.pid}, log ${logPath})`);
  return proc.pid;
}

async function api<T = Record<string, unknown>>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const response = await fetch(`${CENTRAL_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as
    | (T & { ok?: boolean; error?: string })
    | null;
  if (!response.ok || body?.ok === false) {
    die(`central ${init.method ?? "GET"} ${path} failed (${response.status}): ${body?.error}`);
  }
  if (!body) die(`central ${path} returned no JSON`);
  return body;
}

async function assertPortFree(url: string, label: string, envHint: string): Promise<void> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
  } catch {
    return; // Nothing answered — port is ours.
  }
  die(
    `something already answers at ${url} — a foreign ${label} would silently receive this ` +
      `script's admin calls. Pick a free port via ${envHint}.`,
  );
}

// ── 0. preconditions ─────────────────────────────────────────────────

if (!existsSync(join(OTIUM_COPY_DIR, "apps/central-api/src/index.ts"))) {
  die(`otium-copy not found at ${OTIUM_COPY_DIR} (set OTIUM_COPY_DIR)`);
}
await assertPortFree(`${CENTRAL_URL}/auth/methods`, "central-api", "CENTRAL_PORT");
await assertPortFree(`${HUB_URL}/ready`, "runtime-api", "HUB_PORT");
if (existsSync(STATE_FILE)) {
  die(
    `experiment state already exists at ${STATE_FILE}.\n` +
      `Stop the old servers (PIDs in state.json) and remove ${EXPERIMENT_DIR} to start over.`,
  );
}
mkdirSync(EXPERIMENT_DIR, { recursive: true });

// ── 1. central-api ───────────────────────────────────────────────────

console.log(`\n[1/7] booting central-api on :${CENTRAL_PORT}`);
const centralPid = spawnDetached({
  label: "central-api",
  cmd: ["bun", "src/index.ts"],
  cwd: join(OTIUM_COPY_DIR, "apps/central-api"),
  env: {
    CENTRAL_PORT: String(CENTRAL_PORT),
    CENTRAL_STATE_DIR: join(EXPERIMENT_DIR, "central-state"),
    CENTRAL_ADMIN_EMAILS: ADMIN_EMAIL,
    // Non-production default EMAIL_MODE is "dev": /auth/email/start returns
    // the login code in the response body (devCode) — no mail needed.
    NODE_ENV: "development",
  },
});
await waitForHttp(`${CENTRAL_URL}/auth/methods`, "central-api");

// ── 2. admin login (dev email code) ──────────────────────────────────

console.log(`[2/7] logging in as ${ADMIN_EMAIL} (dev email code)`);
const start = await api<{ challengeId: string; devCode?: string }>("/auth/email/start", {
  method: "POST",
  body: JSON.stringify({ email: ADMIN_EMAIL }),
});
if (!start.devCode) {
  die(
    "central did not return devCode — is CENTRAL_EMAIL_MODE overridden? " +
      `Check ${join(EXPERIMENT_DIR, "central-api.log")} for the login code.`,
  );
}
const verify = await api<{ token: string }>("/auth/email/verify", {
  method: "POST",
  body: JSON.stringify({ challengeId: start.challengeId, code: start.devCode }),
});
const TOKEN = verify.token;

// ── 3. workspace ─────────────────────────────────────────────────────

console.log("[3/7] creating workspace");
const slug = `nego-exp-${Date.now().toString(36)}`;
const ws = await api<{ workspace: { id: string } }>("/workspaces", {
  method: "POST",
  token: TOKEN,
  body: JSON.stringify({ slug, name: "otium-coupling-experiment" }),
});
const workspaceId = ws.workspace.id;
console.log(`  workspace ${workspaceId} (slug ${slug})`);

// ── 4. hub cell + primary assignment ─────────────────────────────────

console.log(`[4/7] registering hub cell (direct baseUrl ${HUB_URL})`);
const hubCell = await api<{ cell: { id: string }; secret: string }>("/admin/runtime-cells", {
  method: "POST",
  token: TOKEN,
  body: JSON.stringify({ name: "exp-hub", baseUrl: HUB_URL }),
});
await api("/admin/workspace-assignments", {
  method: "POST",
  token: TOKEN,
  body: JSON.stringify({ workspaceId, runtimeCellId: hubCell.cell.id }),
});
console.log(`  hub cell ${hubCell.cell.id} assigned as primary`);

// ── 5. hub runtime-api ───────────────────────────────────────────────

console.log(`[5/7] booting hub runtime-api on :${HUB_PORT}`);
const adminKey = `exp-admin-${randomBytes(8).toString("hex")}`;
const hubPid = spawnDetached({
  label: "hub-runtime-api",
  cmd: ["bun", "src/api/server.ts"],
  cwd: join(OTIUM_COPY_DIR, "apps/runtime-api"),
  env: {
    API_PORT: String(HUB_PORT),
    HOSTNAME: "127.0.0.1",
    CENTRAL_API_URL: CENTRAL_URL,
    RUNTIME_CELL_ID: hubCell.cell.id,
    RUNTIME_CELL_SECRET: hubCell.secret,
    OTIUM_MULTI_NODE: "1",
    // Keep local access-code login working in hosted mode so run-e2e can
    // create a hub user with ADMIN_KEY instead of the central handoff flow.
    OTIUM_ALLOW_LOCAL_AUTH_IN_HOSTED: "1",
    JWT_SECRET: "dev-anything",
    ADMIN_KEY: adminKey,
    OTIUM_WORKSPACE_DIR: join(EXPERIMENT_DIR, "hub-state/workspace"),
    BOT_DATA_DIR: join(EXPERIMENT_DIR, "hub-state/data"),
    BOT_RUN_DIR: join(EXPERIMENT_DIR, "hub-state/run"),
    NODE_ENV: "development",
  },
});
await waitForHttp(`${HUB_URL}/ready`, "hub runtime-api", 30_000);

// ── 6. worker cell + worker assignment ───────────────────────────────

console.log(`[6/7] registering worker cell "nego" (direct baseUrl ${WORKER_URL})`);
const workerCell = await api<{ cell: { id: string }; secret: string }>("/admin/runtime-cells", {
  method: "POST",
  token: TOKEN,
  body: JSON.stringify({ name: "nego-worker", baseUrl: WORKER_URL }),
});
await api("/admin/workspace-assignments", {
  method: "POST",
  token: TOKEN,
  body: JSON.stringify({
    workspaceId,
    runtimeCellId: workerCell.cell.id,
    worker: true,
    nodeName: "nego",
  }),
});
console.log(`  worker cell ${workerCell.cell.id} attached as "nego"`);

// ── 7. invite code + state ───────────────────────────────────────────

const invite = Buffer.from(
  JSON.stringify({
    v: 1,
    central: CENTRAL_URL,
    cellId: workerCell.cell.id,
    secret: workerCell.secret,
  }),
).toString("base64url");

const state = {
  createdAt: new Date().toISOString(),
  centralUrl: CENTRAL_URL,
  hubUrl: HUB_URL,
  workerUrl: WORKER_URL,
  workspaceId,
  slug,
  adminEmail: ADMIN_EMAIL,
  adminKey,
  hub: { cellId: hubCell.cell.id, pid: hubPid },
  worker: { cellId: workerCell.cell.id, nodeName: "nego" },
  central: { pid: centralPid },
  invite,
};
await Bun.write(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

console.log(`[7/7] done — state saved to ${STATE_FILE}\n`);
console.log("── worker node: run these ─────────────────────────────────────");
console.log(`  negotium otium join ${invite}`);
console.log("  negotium otium serve");
console.log("\n── then drive the E2E ─────────────────────────────────────────");
console.log("  bun scripts/otium-experiment/run-e2e.ts");
console.log("\n(servers keep running; stop with `kill <pid>` — PIDs in state.json)");
