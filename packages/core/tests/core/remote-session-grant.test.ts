import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  decodeRemoteSessionGrantArg,
  encodeRemoteSessionGrantArg,
  mergeRemoteSessionGrants,
  parseRemoteSessionGrant,
  REMOTE_SESSION_GRANT_LIMITS,
  remoteSessionGrantExpiry,
  remoteSessionGrantFrom,
  validateRemoteSessionGrant,
} from "#runtime/remote-session-grant";

/** A capability shaped like the hub's `rsc1.<payload>.<hmac>`; the node never verifies it. */
export function fakeCapability(payload: Record<string, unknown> = {}): string {
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      t: "rsc",
      j: randomBytes(16).toString("base64url"),
      a: "person",
      c: "",
      h: "hub-topic",
      n: "node-topic",
      q: "request",
      i: 1_800_000_000,
      e: 1_800_014_400,
      ...payload,
    }),
  ).toString("base64url");
  return `rsc1.${body}.${randomBytes(32).toString("base64url")}`;
}

describe("validateRemoteSessionGrant", () => {
  test("accepts a loopback http hub and any https hub, normalizing the origin", () => {
    const capability = fakeCapability();
    for (const hubUrl of [
      "http://127.0.0.1:3100",
      "http://localhost:3100/",
      "http://[::1]:3100",
      "https://hub.example",
      "https://hub.example:8443/base/",
    ]) {
      const result = validateRemoteSessionGrant({ hubUrl, capability });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.grant?.hubUrl.endsWith("/")).toBe(false);
      expect(result.grant?.capability).toBe(capability);
    }
    expect(parseRemoteSessionGrant({ hubUrl: "https://hub.example/", capability })?.hubUrl).toBe(
      "https://hub.example",
    );
    expect(validateRemoteSessionGrant(undefined)).toEqual({ ok: true, grant: undefined });
  });

  test("refuses a non-loopback http hub, other schemes, credentials and queries", () => {
    const capability = fakeCapability();
    for (const hubUrl of [
      "http://hub.example",
      "http://10.0.0.5:3100",
      "ftp://127.0.0.1",
      "https://user:pw@hub.example",
      "https://hub.example/?x=1",
      "https://hub.example/#frag",
      "not a url",
      "",
      `https://hub.example/${"a".repeat(REMOTE_SESSION_GRANT_LIMITS.maxHubUrlLength)}`,
    ]) {
      const result = validateRemoteSessionGrant({ hubUrl, capability });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`accepted ${hubUrl}`);
      expect(result.error).toContain("hubUrl");
    }
  });

  test("refuses a capability that is too long, wrongly prefixed or malformed", () => {
    const hubUrl = "https://hub.example";
    const tooLong = `rsc1.${"a".repeat(REMOTE_SESSION_GRANT_LIMITS.maxCapabilityLength)}.b`;
    for (const capability of ["", "rsc2.abc.def", "abc.def", "rsc1.abc", "rsc1.a b.c", tooLong]) {
      const result = validateRemoteSessionGrant({ hubUrl, capability });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`accepted ${capability.slice(0, 20)}`);
      expect(result.error).toContain("capability");
    }
    // Exactly at the cap is accepted.
    const atCap = `rsc1.${"a".repeat(REMOTE_SESSION_GRANT_LIMITS.maxCapabilityLength - 7)}.b`;
    expect(atCap.length).toBe(REMOTE_SESSION_GRANT_LIMITS.maxCapabilityLength);
    expect(validateRemoteSessionGrant({ hubUrl, capability: atCap }).ok).toBe(true);
  });

  test("refuses anything that is not exactly { hubUrl, capability }", () => {
    const capability = fakeCapability();
    for (const value of [
      null,
      "grant",
      [],
      { hubUrl: "https://hub.example" },
      { capability },
      { hubUrl: "https://hub.example", capability, extra: true },
      Object.create({ hubUrl: "https://hub.example", capability }),
    ]) {
      expect(validateRemoteSessionGrant(value).ok).toBe(false);
      expect(parseRemoteSessionGrant(value)).toBeNull();
      expect(remoteSessionGrantFrom(value)).toBeUndefined();
    }
  });

  test("argv encoding round-trips and re-validates", () => {
    const grant = { hubUrl: "https://hub.example", capability: fakeCapability() };
    const encoded = encodeRemoteSessionGrantArg(grant);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRemoteSessionGrantArg(encoded)).toEqual(grant);
    expect(decodeRemoteSessionGrantArg("not-base64-json")).toBeNull();
    expect(() =>
      encodeRemoteSessionGrantArg({ hubUrl: "http://hub.example", capability: grant.capability }),
    ).toThrow("hubUrl");
  });
});

describe("mergeRemoteSessionGrants", () => {
  const hubUrl = "https://hub.example";

  test("keeps the latest-expiring grant when every folded request has one for the same hub", () => {
    const early = { hubUrl, capability: fakeCapability({ e: 1_800_000_100 }) };
    const late = { hubUrl, capability: fakeCapability({ e: 1_800_000_900 }) };
    const mid = { hubUrl, capability: fakeCapability({ e: 1_800_000_500 }) };
    expect(remoteSessionGrantExpiry(late)).toBe(1_800_000_900);
    expect(mergeRemoteSessionGrants([early, late, mid])).toBe(late);
    expect(mergeRemoteSessionGrants([late])).toBe(late);
  });

  test("a request without a grant, or for another hub, leaves the batch without one", () => {
    const one = { hubUrl, capability: fakeCapability() };
    expect(mergeRemoteSessionGrants([])).toBeUndefined();
    expect(mergeRemoteSessionGrants([one, undefined])).toBeUndefined();
    expect(mergeRemoteSessionGrants([undefined, one])).toBeUndefined();
    expect(
      mergeRemoteSessionGrants([
        one,
        { hubUrl: "https://other.example", capability: one.capability },
      ]),
    ).toBeUndefined();
  });

  test("an unreadable expiry falls back to the newest request", () => {
    const opaque = { hubUrl, capability: "rsc1.bm90LWpzb24.c2ln" };
    const newest = { hubUrl, capability: "rsc1.YWxzby1ub3QtanNvbg.c2ln" };
    expect(remoteSessionGrantExpiry(opaque)).toBeNull();
    expect(mergeRemoteSessionGrants([opaque, newest])).toBe(newest);
  });
});
