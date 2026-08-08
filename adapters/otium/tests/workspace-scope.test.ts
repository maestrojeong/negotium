import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "@negotium/core";
import { configureOtiumCentral, resetPeerCentralCaches } from "@/central";
import type { OtiumJoin } from "@/join";
import { cachedSurfaceScope, resolveSurfaceScope, surfaceScopeFor } from "@/workspace-scope";

const cachePath = resolve(DATA_DIR, "otium-workspace.json");

function makeJoin(patch: Partial<OtiumJoin> = {}): OtiumJoin {
  return { central: "http://127.0.0.1:4600", cellId: "cell_a", secret: "rcs_a", ...patch };
}

afterEach(() => {
  if (existsSync(cachePath)) rmSync(cachePath);
  configureOtiumCentral(null);
  resetPeerCentralCaches();
});

describe("otium workspace scope", () => {
  test("is derived from the workspace, so a re-issued seat keeps the same scope", () => {
    const central = "http://127.0.0.1:4600";
    const before = surfaceScopeFor(central, "ws-1");
    // Re-inviting a node mints a new cellId and secret; neither may move rooms.
    expect(surfaceScopeFor(central, "ws-1")).toBe(before);
    expect(surfaceScopeFor(central, "ws-2")).not.toBe(before);
  });

  test("separates identical workspace ids issued by two deployments", () => {
    expect(surfaceScopeFor("https://a.example", "ws-1")).not.toBe(
      surfaceScopeFor("https://b.example", "ws-1"),
    );
  });

  test("an unresolved scope is a normal state, not an error", async () => {
    const join = makeJoin({ central: "http://127.0.0.1:1" });
    configureOtiumCentral(join);
    expect(cachedSurfaceScope(join)).toBeNull();
    expect(await resolveSurfaceScope(join)).toBeNull();
  });

  test("resolves once against central and answers from disk afterwards", async () => {
    const join = makeJoin();
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ ok: true, workspaceId: "ws-1", nodes: [] });
    }) as typeof fetch;
    try {
      configureOtiumCentral(join);
      expect(await resolveSurfaceScope(join)).toBe(surfaceScopeFor(join.central, "ws-1"));
      expect(calls).toBe(1);

      // A restart has no caches but must still know its workspace before the
      // first Central contact, or it would file rooms unscoped during an outage.
      resetPeerCentralCaches();
      expect(cachedSurfaceScope(join)).toBe(surfaceScopeFor(join.central, "ws-1"));
      expect(await resolveSurfaceScope(join)).toBe(surfaceScopeFor(join.central, "ws-1"));
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("ignores a cache entry recorded against a different central", async () => {
    const join = makeJoin();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ ok: true, workspaceId: "ws-1", nodes: [] })) as typeof fetch;
    try {
      configureOtiumCentral(join);
      await resolveSurfaceScope(join);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(cachedSurfaceScope(makeJoin({ central: "https://elsewhere.example" }))).toBeNull();
  });
});
