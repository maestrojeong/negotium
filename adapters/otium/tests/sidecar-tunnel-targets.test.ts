import { afterEach, describe, expect, test } from "bun:test";
import { resolveTunnelTargets } from "@/sidecar";

/**
 * Regression coverage for the bug this file exists to prevent: the sidecar
 * used to build exactly one `TunnelClient` from `loadJoins()[0]` — the oldest
 * join by file order — so a host joined to several workspaces (or carrying a
 * dead join left over from a revoked enrollment) got a relay tunnel for only
 * one of them, chosen by accident of ordering, while the rest sat on disk
 * with no tunnel ever attempted and no log line to say so.
 */

const originalEnvRelay = process.env.OTIUM_RELAY_URL;

afterEach(() => {
  if (originalEnvRelay === undefined) delete process.env.OTIUM_RELAY_URL;
  else process.env.OTIUM_RELAY_URL = originalEnvRelay;
});

function join(cellId: string, relay?: string, secret = `rcs_${cellId}`) {
  return { cellId, relay, secret };
}

describe("resolveTunnelTargets", () => {
  test("every joined workspace gets its own target, not just the first", () => {
    delete process.env.OTIUM_RELAY_URL;
    const joins = [
      join("cell_oldest", "https://relay-oldest.example.com"),
      join("cell_middle", "https://relay-middle.example.com"),
      join("cell_newest", "https://relay-newest.example.com"),
    ];
    const { targets, skippedNoRelay } = resolveTunnelTargets(joins);

    expect(skippedNoRelay).toEqual([]);
    expect(targets.map((t) => t.cellId)).toEqual(["cell_oldest", "cell_middle", "cell_newest"]);
    // Each target carries its OWN join's secret and relay — the whole point
    // is that a dead cell_oldest secret cannot be the one every join dials.
    for (const j of joins) {
      const target = targets.find((t) => t.cellId === j.cellId);
      expect(target?.secret).toBe(j.secret);
      expect(target?.relayUrl).toBe(j.relay);
    }
  });

  test("a join with no relay anywhere is reported skipped, not silently dropped", () => {
    delete process.env.OTIUM_RELAY_URL;
    const joins = [join("cell_has_relay", "https://relay.otium.team"), join("cell_no_relay")];
    const { targets, skippedNoRelay } = resolveTunnelTargets(joins);

    expect(targets.map((t) => t.cellId)).toEqual(["cell_has_relay"]);
    expect(skippedNoRelay).toEqual(["cell_no_relay"]);
  });

  test("an explicit relay override applies to every join uniformly", () => {
    const joins = [
      join("cell_a", "https://relay-a.example.com"),
      join("cell_b", "https://relay-b.example.com"),
    ];
    const { targets, skippedNoRelay } = resolveTunnelTargets(
      joins,
      "https://relay-override.example.com",
    );

    expect(skippedNoRelay).toEqual([]);
    for (const target of targets) {
      expect(target.relayUrl).toBe("https://relay-override.example.com");
    }
  });

  test("OTIUM_RELAY_URL is the last-resort fallback when a join has no relay of its own", () => {
    process.env.OTIUM_RELAY_URL = "https://relay-env.example.com";
    const { targets, skippedNoRelay } = resolveTunnelTargets([join("cell_a")]);

    expect(skippedNoRelay).toEqual([]);
    expect(targets).toEqual([
      { cellId: "cell_a", relayUrl: "https://relay-env.example.com", secret: "rcs_cell_a" },
    ]);
  });

  test("no joins produces no targets and no false skip report", () => {
    expect(resolveTunnelTargets([])).toEqual({ targets: [], skippedNoRelay: [] });
  });
});
