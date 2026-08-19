/**
 * Cross-process smoke for the gateway read-back contract.
 *
 * `GET /topics/:id/visuals/:vizId` and `GET /topics/:id/files/:fileId` are what
 * let a hub copy a node-rendered visual, or a node-held file, into its own store
 * — without them a mapped room's `show_*` / `send_file` is callable and produces
 * nothing the user can see. The unit tests stub the client, so this is the only
 * check that a real node serves them over real HTTP with real auth and real
 * workspace scoping.
 *
 * Deliberately not a full mapped turn: no agent, no central-api, no hub. It runs
 * a node against an isolated state dir, plants exactly what a turn would, and
 * drives the endpoints the way Otium's client does.
 *
 * Both defects this has caught were about *who* may read, not whether the route
 * exists, so the cases below are mostly authorization:
 *   - a file stored with an owner (`send_file`)
 *   - a file stored with no owner at all (`show_image`/`show_video` resolved from
 *     `file_path` — this one silently 404'd in 0.5.6 and produced a blank panel)
 *   - the same ids named through a room that does not hold them
 *
 *   bun scripts/gateway-readback-smoke.ts
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONTRACT = "/api/v1/control/runtime/v1";
const PORT = 43977;

let failures = 0;

function ok(label: string): void {
  console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
}

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    ok(label);
    return;
  }
  failures += 1;
  console.error(`  \x1b[31mFAIL\x1b[0m ${label}`);
  if (detail !== undefined) {
    console.error(`       ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}

const stateDir = join(tmpdir(), `negotium-gateway-smoke-${randomUUID()}`);
mkdirSync(stateDir, { recursive: true });
process.env.NEGOTIUM_STATE_DIR = stateDir;

// Imported after the state dir is set, so config binds to the isolated store
// rather than the developer's real one.
const { NODE_CONTROL_TOKEN } = await import("@negotium/core/node-host");
const { db, registerTopic } = await import("@negotium/core");
const { nodeFileStore } = await import("../packages/node/src/files");
const { createNodeControlHandler } = await import("../packages/node/src/control");

const handler = createNodeControlHandler({
  port: () => PORT,
  startedAt: new Date().toISOString(),
  requestShutdown() {},
});

// A real server, so this exercises the transport rather than calling the
// handler function directly.
const server = Bun.serve({
  port: PORT,
  fetch: async (req) => (await handler(req)) ?? new Response("not found", { status: 404 }),
});

const base = `http://127.0.0.1:${PORT}${CONTRACT}`;
const auth = { authorization: `Bearer ${NODE_CONTROL_TOKEN}` };

// The principal every mapped room executes as. `POST /turns` refuses a topic it
// does not participate in, so a gateway room always has it.
const principal = "local";

try {
  const room = registerTopic({
    title: `Gateway smoke ${randomUUID()}`,
    userId: principal,
    agent: "codex",
    surface: "otium",
  });
  const otherRoom = registerTopic({
    title: `Gateway smoke other ${randomUUID()}`,
    userId: principal,
    agent: "codex",
    surface: "otium",
  });

  console.log("\nvisual read-back");

  const vizId = Number(
    (
      db
        .query(
          `INSERT INTO api_topic_visuals (topic_id, html, title, created_at, kind, source)
           VALUES (?, ?, ?, ?, 'html', ?) RETURNING id`,
        )
        .get(
          room.id,
          "<html><body>rendered</body></html>",
          "Smoke chart",
          Date.now(),
          "<p>src</p>",
        ) as { id: number }
    ).id,
  );

  const visualRes = await fetch(`${base}/topics/${room.id}/visuals/${vizId}`, { headers: auth });
  const visualBody = visualRes.ok
    ? ((await visualRes.json()) as { visual?: Record<string, unknown> })
    : null;
  check(
    "a node visual is readable over the contract",
    visualRes.status === 200 &&
      visualBody?.visual?.id === vizId &&
      visualBody?.visual?.source === "<p>src</p>" &&
      visualBody?.visual?.kind === "html",
    { status: visualRes.status, body: visualBody },
  );

  const crossVisual = await fetch(`${base}/topics/${otherRoom.id}/visuals/${vizId}`, {
    headers: auth,
  });
  check(
    "a visual id named through the wrong room is refused",
    crossVisual.status === 404,
    crossVisual.status,
  );

  const noAuthVisual = await fetch(`${base}/topics/${room.id}/visuals/${vizId}`);
  check(
    "an unauthenticated visual read is refused",
    noAuthVisual.status === 401,
    noAuthVisual.status,
  );

  console.log("\nfile read-back");

  const scratch = join(stateDir, "delivered.txt");
  writeFileSync(scratch, "delivered bytes");

  // How `send_file` stores a file.
  const owned = nodeFileStore.store(scratch, { ownerUserId: principal, topicId: room.id });
  // How a media visual resolved from `file_path` stores one: no owner.
  const ownerless = nodeFileStore.store(scratch, { topicId: room.id });
  if (!owned || !ownerless) throw new Error("could not stage node files");

  const ownedRes = await fetch(`${base}/topics/${room.id}/files/${owned.id}?user=${principal}`, {
    headers: auth,
  });
  check(
    "a delivered file is readable through its room",
    ownedRes.status === 200 && (await ownedRes.text()) === "delivered bytes",
    ownedRes.status,
  );

  const ownerlessRes = await fetch(
    `${base}/topics/${room.id}/files/${ownerless.id}?user=${principal}`,
    { headers: auth },
  );
  check(
    "a media file stored without an owner is readable too",
    ownerlessRes.status === 200 && (await ownerlessRes.text()) === "delivered bytes",
    ownerlessRes.status,
  );

  for (const [label, fileId] of [
    ["a delivered", owned.id],
    ["an ownerless", ownerless.id],
  ] as const) {
    const wrongRoom = await fetch(
      `${base}/topics/${otherRoom.id}/files/${fileId}?user=${principal}`,
      { headers: auth },
    );
    check(
      `${label} file id named through the wrong room is refused`,
      wrongRoom.status === 404,
      wrongRoom.status,
    );
  }

  const bareFile = await fetch(`${base}/files/${owned.id}?user=${principal}`, { headers: auth });
  check(
    "the unscoped file route does not exist on the contract",
    bareFile.status !== 200,
    bareFile.status,
  );

  if (failures === 0) {
    console.log("\n\x1b[32mall gateway read-back checks passed\x1b[0m");
  } else {
    console.error(`\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  }
} finally {
  server.stop(true);
  rmSync(stateDir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
