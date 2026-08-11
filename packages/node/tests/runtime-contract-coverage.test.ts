import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Guard against capability drift between the two surfaces `control.ts` serves.
 *
 * The control routes (`/api/v1/control/...`) are what Terminal and Telegram can
 * do; the contract (`/api/v1/control/runtime/v1/...`) is what Otium can do. They
 * have drifted twice now — a verb was added for the local adapters and the
 * gateway simply could not express it, so the same action was impossible from
 * Otium (D-1: the node owns the room, so a gap here is a gap, not a workaround).
 *
 * Rather than pin a hand-written list that rots the moment someone edits the
 * handler, this reads `control.ts` and derives both route tables from the actual
 * matchers. A mutating control route must then be either mirrored in the
 * contract or named in DELIBERATELY_LOCAL_ONLY below with a reason — so the next
 * person adding one has to make the choice consciously instead of by omission.
 */
const CONTROL_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/control.ts", import.meta.url)),
  "utf8",
);

/**
 * Control routes that are intentionally absent from the contract.
 *
 * Every entry is a decision, not a backlog item that happens to be unfinished.
 * Adding one is how you say "a host must not be able to do this", or "a host
 * reaches this a different way"; the reason is the review.
 */
const DELIBERATELY_LOCAL_ONLY = new Map<string, string>([
  // Stopping the node is host lifecycle: whoever owns the machine owns it, and
  // a remote hub killing a worker's daemon is not a room operation.
  ["POST /shutdown", "host lifecycle, belongs to the machine's operator"],
  // Secrets are scoped to the machine's owner, never to a workspace that merely
  // runs turns on one of its rooms.
  ["POST /vault", "machine-owner-only secret storage"],
  ["DELETE /vault", "machine-owner-only secret storage"],
  ["POST /vault/command", "machine-owner-only secret storage"],
  // Node identity, not topic state — see the comment on the route itself. Each
  // computer keeps the name its own operator gave it.
  ["PATCH /ai-name", "node identity is deliberately loopback-only"],
  // The contract's equivalent is `POST /turns`, which carries the idempotency
  // key, the actor attribution split (D-4) and the `respond` flag this route has
  // no notion of. Mirroring the simpler shape would be a second ingress.
  ["POST /topics/:id/messages", "superseded by POST /turns, which is the richer ingress"],
  // Per-field switches that `PATCH /topics/:id` already covers for the contract,
  // in one call and with the config-override clearing that route needs.
  ["POST /topics/:id/model", "subsumed by PATCH /topics/:id"],
  ["POST /topics/:id/effort", "subsumed by PATCH /topics/:id"],
  // A callback from the node's own visual renderer writing back a rendered SVG;
  // there is no remote caller for it.
  ["POST /topics/:id/decision-graph", "local renderer callback, not a host operation"],
  // Forking creates a room, which collides with Otium's mirror/mapping
  // lifecycle: the new topic would appear unmapped and be re-mirrored as a
  // second room. Needs its own design pass before it gets a contract verb.
  ["POST /topics/:id/derive", "creates a room; needs a mirror/mapping design pass first"],
  // A real gap, but the write alone is unusable: the contract has no way to
  // *read* the pending questions, so a host could never learn the message id to
  // answer. Both halves have to land together.
  ["POST /questions/:id/answer", "needs a contract read for pending questions first"],
]);

/** `^\/topics\/([^/]+)\/abort$` → `/topics/:id/abort`. */
function readableRoute(regexBody: string): string {
  return regexBody
    .replaceAll("\\/", "/")
    .replaceAll("([^/]+)", ":id")
    .replaceAll("([0-9a-f-]+)", ":id");
}

/** Every `METHOD /path` the given slice of the handler answers. */
function routesIn(source: string, pathVariable: "path" | "runtimePath"): Set<string> {
  const routes = new Set<string>();

  // `req.method === "GET" && path === "/status"`, in either order.
  const literal = new RegExp(
    `req\\.method === "(\\w+)" && ${pathVariable} === "([^"]+)"` +
      `|${pathVariable} === "([^"]+)" && req\\.method === "(\\w+)"`,
    "g",
  );
  for (const match of source.matchAll(literal)) {
    const method = match[1] ?? match[4];
    const path = match[2] ?? match[3];
    routes.add(`${method} ${path}`);
  }

  // `const fooMatch = path.match(/^\/topics\/([^/]+)\/abort$/);` paired with
  // every `if (fooMatch && req.method === "POST")` that consumes it. Anchored on
  // `$/` because every matcher in the handler is fully anchored; a future one
  // that is not would go unseen, so the count assertions below are the backstop.
  const declarations = new Map<string, string>();
  const declaration = new RegExp(
    `const (\\w+) = ${pathVariable}\\.match\\(/\\^(.*?)\\$/[a-z]*\\);`,
    "g",
  );
  for (const match of source.matchAll(declaration)) {
    declarations.set(match[1], readableRoute(match[2]));
  }
  for (const match of source.matchAll(/if \((\w+) && req\.method === "(\w+)"\)/g)) {
    const path = declarations.get(match[1]);
    if (path) routes.add(`${match[2]} ${path}`);
  }

  return routes;
}

const CONTRACT_START = "if (runtimePath !== null) {";
const CONTRACT_END = 'return jsonError(404, "Runtime contract route not found");';
const CONTROL_END = 'return jsonError(404, "Control route not found");';

function sliceBetween(start: string, end: string): string {
  const from = CONTROL_SOURCE.indexOf(start);
  const to = CONTROL_SOURCE.indexOf(end);
  if (from < 0 || to < 0 || to <= from) {
    throw new Error(`control.ts no longer contains the markers ${start} … ${end}`);
  }
  return CONTROL_SOURCE.slice(from, to);
}

const contractRoutes = routesIn(sliceBetween(CONTRACT_START, CONTRACT_END), "runtimePath");
const controlRoutes = routesIn(sliceBetween(CONTRACT_END, CONTROL_END), "path");

test("the route tables are actually being parsed out of control.ts", () => {
  // Without this the whole file degrades silently into a no-op the day someone
  // renames a variable or changes how routes are matched.
  expect(controlRoutes.size).toBeGreaterThanOrEqual(15);
  expect(contractRoutes.size).toBeGreaterThanOrEqual(8);
  expect(controlRoutes).toContain("POST /topics/:id/abort");
  expect(controlRoutes).toContain("GET /status");
  expect(contractRoutes).toContain("POST /turns");
  expect(contractRoutes).toContain("PATCH /topics/:id");
});

test("every mutating control route is mirrored in the contract or deliberately not", () => {
  // Reads are excluded on purpose: a missing read is a smaller, reversible gap,
  // and the contract's read surface is shaped by workspace scoping rather than
  // by the control routes. A missing *write* is what leaves a host unable to
  // perform an action at all, which is the drift this guards.
  const mutating = [...controlRoutes].filter((route) => !route.startsWith("GET ")).sort();

  const undecided = mutating.filter(
    (route) => !contractRoutes.has(route) && !DELIBERATELY_LOCAL_ONLY.has(route),
  );
  expect(
    undecided,
    "New mutating control route with no contract counterpart. Either add one under " +
      "NODE_RUNTIME_CONTRACT_BASE_PATH, or add it to DELIBERATELY_LOCAL_ONLY with a reason.",
  ).toEqual([]);
});

test("the deliberate-exclusion list does not outlive the routes it excuses", () => {
  // An entry for a route that no longer exists, or that has since gained a
  // contract counterpart, is a stale claim; it would go on silently excusing a
  // path that could later be re-added for a different reason.
  for (const route of DELIBERATELY_LOCAL_ONLY.keys()) {
    expect(controlRoutes, `${route} is excused but no longer a control route`).toContain(route);
    expect(contractRoutes, `${route} is excused but the contract has it`).not.toContain(route);
  }
});

test("the turn and session verbs are on both surfaces", () => {
  for (const route of [
    "POST /topics/:id/abort",
    "POST /topics/:id/session/reset",
    "POST /topics/:id/session/compact",
  ]) {
    expect(controlRoutes, route).toContain(route);
    expect(contractRoutes, route).toContain(route);
  }
});
