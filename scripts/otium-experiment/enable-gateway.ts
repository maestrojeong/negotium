#!/usr/bin/env bun
/**
 * otium ↔ negotium coupling experiment — turn the Runtime Gateway on.
 *
 * `hub-setup.ts` boots the hub before the worker even exists, so it cannot
 * know the worker's `node-control-token` yet (docs/OTIUM-NODE-ARCHITECTURE.md
 * D-2: the loopback transport authenticates with that token, minted only once
 * the Node has started). This script closes that gap once the worker is up:
 * it reads the token the Node wrote to disk, restarts hub-runtime-api with
 * `OTIUM_NEGOTIUM_GATEWAY_*` set, and waits for `/ready` again.
 *
 * Run this after `otium join` + `otium serve` on the worker side, and before
 * `run-e2e.ts`.
 *
 * Usage:
 *   bun scripts/otium-experiment/enable-gateway.ts
 * Env overrides: EXPERIMENT_DIR (default: /tmp/otium-experiment)
 */

import { existsSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const EXPERIMENT_DIR = resolve(process.env.EXPERIMENT_DIR ?? "/tmp/otium-experiment");
const STATE_FILE = join(EXPERIMENT_DIR, "state.json");

function die(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

if (!existsSync(STATE_FILE)) die(`no ${STATE_FILE} — run hub-setup.ts first`);
const state = (await Bun.file(STATE_FILE).json()) as {
  hubUrl: string;
  workerStateDir: string;
  hub: { cellId: string; pid: number; env?: Record<string, string> };
  worker: { cellId: string; nodeName: string; nodePort: number };
};

const tokenPath = join(state.workerStateDir, "secrets", "node-control-token");
if (!existsSync(tokenPath)) {
  die(
    `${tokenPath} does not exist yet — has the worker been started ` +
      `(\`otium join\` + \`otium serve\`)? The Node writes this file on first boot.`,
  );
}
const nodeControlToken = readFileSync(tokenPath, "utf8").trim();
if (!nodeControlToken) die(`${tokenPath} is empty`);

const nodeBaseUrl = `http://127.0.0.1:${state.worker.nodePort}`;
console.log(`[1/3] found node-control-token, Node at ${nodeBaseUrl}`);

// ── restart hub-runtime-api with the Gateway turned on ───────────────

console.log(`[2/3] restarting hub-runtime-api (pid ${state.hub.pid}) with the Gateway enabled`);

function pidAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing but still throws ESRCH if the pid is gone —
    // the standard liveness probe.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (pidAlive(state.hub.pid)) {
  process.kill(state.hub.pid, "SIGTERM");
  // otium-runtime's shutdown lifecycle has a known gap: it logs "shutdown
  // sequence complete" after its registered handlers finish, but that does
  // not always mean the process itself has exited or released its listening
  // socket (observed directly while building this script — the old process
  // kept answering `/ready`, unchanged, indefinitely after SIGTERM). Waiting
  // on "does the port answer" alone is therefore not a valid free-port
  // signal here; wait on the *pid* actually dying instead, and escalate to
  // SIGKILL if it does not.
  const gracefulDeadline = Date.now() + 5_000;
  while (Date.now() < gracefulDeadline && pidAlive(state.hub.pid)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (pidAlive(state.hub.pid)) {
    console.log(`  pid ${state.hub.pid} ignored SIGTERM after 5s — sending SIGKILL`);
    try {
      process.kill(state.hub.pid, "SIGKILL");
    } catch {
      // Already gone between the check and the kill — fine.
    }
    const killDeadline = Date.now() + 5_000;
    while (Date.now() < killDeadline && pidAlive(state.hub.pid)) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
} else {
  console.log(`  pid ${state.hub.pid} was already gone`);
}
if (pidAlive(state.hub.pid)) die(`pid ${state.hub.pid} would not die — cannot safely restart`);

const hubCwd = join(
  resolve(process.env.OTIUM_COPY_DIR ?? `${process.env.HOME}/otium`),
  "apps/runtime-api",
);
const logPath = join(EXPERIMENT_DIR, "hub-runtime-api.log");
const fd = openSync(logPath, "a");
const proc = Bun.spawn(["bun", "src/api/server.ts"], {
  cwd: hubCwd,
  env: {
    ...process.env,
    ...(state.hub.env ?? {}),
    OTIUM_NEGOTIUM_GATEWAY_ENABLED: "1",
    OTIUM_NEGOTIUM_GATEWAY_EXECUTION_ENABLED: "1",
    OTIUM_NEGOTIUM_GATEWAY_BASE_URL: nodeBaseUrl,
    OTIUM_NEGOTIUM_GATEWAY_TOKEN: nodeControlToken,
  },
  detached: true,
  stdout: fd,
  stderr: fd,
  stdin: "ignore",
});
proc.unref();
console.log(`  spawned hub-runtime-api (pid ${proc.pid}, log ${logPath})`);

// A bare "status < 500" check would pass just as happily against a stray
// zombie of the *old* process if the pid-kill above somehow missed it, and
// that old process is exactly the one still running without the Gateway env
// — so require the ready payload to actually report the Gateway as enabled,
// not merely that something answered.
const readyDeadline = Date.now() + 20_000;
let up = false;
let lastBody: { negotiumGateway?: { enabled?: boolean; configured?: boolean } } | null = null;
while (Date.now() < readyDeadline) {
  try {
    const response = await fetch(`${state.hubUrl}/ready`, { signal: AbortSignal.timeout(1500) });
    if (response.status < 500) {
      lastBody = await response.json().catch(() => null);
      if (lastBody?.negotiumGateway?.enabled) {
        up = true;
        break;
      }
    }
  } catch {
    // Not up yet.
  }
  await new Promise((r) => setTimeout(r, 300));
}
if (!up) {
  die(
    `hub-runtime-api did not come back up with the Gateway enabled within 20s ` +
      `(last /ready: ${JSON.stringify(lastBody)}).\n` +
      `If a stale process is still holding :${new URL(state.hubUrl).port}, find and kill it, ` +
      `then re-run this script.`,
  );
}

state.hub.pid = proc.pid;
await Bun.write(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

console.log(`[3/3] done — hub-runtime-api is back up (pid ${proc.pid}) with the Gateway enabled`);
console.log("\n  bun scripts/otium-experiment/run-e2e.ts");
