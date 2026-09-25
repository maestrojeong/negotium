import { describe, expect, test } from "bun:test";
import {
  ACTOR_TOPIC_SCOPE_DEFAULT_MAX_AGE_MS,
  ACTOR_TOPIC_SCOPE_LIMITS,
  ACTOR_TOPIC_SCOPE_MAX_AGE_CEILING_MS,
  actorTopicScopeFrom,
  actorTopicScopeMaxAgeMs,
  encodeActorTopicScopeArg,
  intersectActorTopicScopes,
  isActorTopicScopeFresh,
  parseActorTopicScope,
  stampActorTopicScope,
  validateActorTopicScope,
} from "#runtime/actor-topic-scope";

describe("actor topic scope assertion", () => {
  test("absent stays absent; a well-formed assertion is normalized", () => {
    expect(parseActorTopicScope(undefined)).toBeUndefined();
    expect(
      parseActorTopicScope({
        visibleNodeTopicIds: ["a", " b ", "a"],
        ownedNodeTopicIds: ["b"],
      }),
    ).toEqual({ visibleNodeTopicIds: ["a", "b"], ownedNodeTopicIds: ["b"] });
  });

  test("anything malformed is rejected rather than read as an assertion", () => {
    for (const value of [
      null,
      "everything",
      [],
      {},
      { visibleNodeTopicIds: ["a"] },
      { visibleNodeTopicIds: "a", ownedNodeTopicIds: [] },
      { visibleNodeTopicIds: [""], ownedNodeTopicIds: [] },
      { visibleNodeTopicIds: [1], ownedNodeTopicIds: [] },
    ]) {
      expect(parseActorTopicScope(value)).toBeNull();
      // A persisted row that no longer validates narrows the turn instead of
      // widening it or throwing.
      expect(actorTopicScopeFrom(value)).toBeUndefined();
    }
  });

  test("argv encoding round-trips through the parser", () => {
    const scope = { visibleNodeTopicIds: ["v1", "v2"], ownedNodeTopicIds: ["v2"] };
    const encoded = encodeActorTopicScopeArg(scope);
    expect(encoded).not.toContain("=");
    expect(
      parseActorTopicScope(JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"))),
    ).toEqual(scope);
  });

  test("argv encoding enforces the same caps and throws rather than truncating", () => {
    const { maxSerializedBytes, maxIdsPerList } = ACTOR_TOPIC_SCOPE_LIMITS;
    // Exactly the byte cap is accepted (same construction as the parser test).
    const ids = Array.from({ length: 64 }, (_, i) => `${"a".repeat(120)}-${i}`);
    const base = { visibleNodeTopicIds: ids, ownedNodeTopicIds: [] as string[] };
    const padding = maxSerializedBytes - Buffer.byteLength(JSON.stringify(base), "utf-8") - 3;
    const exact = { ...base, visibleNodeTopicIds: [...ids, "p".repeat(padding)] };
    expect(Buffer.byteLength(JSON.stringify(exact), "utf-8")).toBe(maxSerializedBytes);
    const encoded = encodeActorTopicScopeArg(exact);
    expect(encoded.length).toBeLessThanOrEqual(10_924);
    expect(
      parseActorTopicScope(JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"))),
    ).toEqual(exact);
    // One byte over throws — the argv entry is never minted shorter or wider.
    expect(() =>
      encodeActorTopicScopeArg({ ...base, visibleNodeTopicIds: [...ids, "p".repeat(padding + 1)] }),
    ).toThrow(`at most ${maxSerializedBytes}`);
    // A typed in-process caller with an oversized object is refused too.
    expect(() =>
      encodeActorTopicScopeArg({
        visibleNodeTopicIds: Array.from({ length: maxIdsPerList + 1 }, (_, i) => `n-${i}`),
        ownedNodeTopicIds: [],
      }),
    ).toThrow(`at most ${maxIdsPerList}`);
    expect(() => encodeActorTopicScopeArg({ visibleNodeTopicIds: ["a"] } as never)).toThrow(
      "both visibleNodeTopicIds and ownedNodeTopicIds",
    );
  });
});

describe("actor topic scope limits", () => {
  const ids = (count: number, prefix = "id") =>
    Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
  const scope = (visible: string[], owned: string[] = []) => ({
    visibleNodeTopicIds: visible,
    ownedNodeTopicIds: owned,
  });

  test("the caps are the ones the transport was sized for", () => {
    expect(ACTOR_TOPIC_SCOPE_LIMITS).toEqual({
      maxIdsPerList: 200,
      maxIdLength: 128,
      maxSerializedBytes: 8192,
    });
    // 4/3 of the byte cap is what the assertion adds to a token in a URL that
    // Bun.serve cuts off at ~16 KiB; keep the headroom if this ever moves.
    expect(Math.ceil((ACTOR_TOPIC_SCOPE_LIMITS.maxSerializedBytes * 4) / 3)).toBeLessThan(12_000);
  });

  test("accepts exactly the per-list count and rejects one more", () => {
    const { maxIdsPerList } = ACTOR_TOPIC_SCOPE_LIMITS;
    const full = scope(ids(maxIdsPerList), ids(maxIdsPerList, "own"));
    expect(parseActorTopicScope(full)).toEqual(full);
    const over = validateActorTopicScope(scope(ids(maxIdsPerList + 1)));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain(`at most ${maxIdsPerList}`);
    // Duplicates count toward the cap before de-duplication: the cap bounds
    // the work done on the input, not the size of the result.
    const duplicated = validateActorTopicScope(
      scope(Array.from({ length: maxIdsPerList + 1 }, () => "same")),
    );
    expect(duplicated.ok).toBe(false);
    expect(parseActorTopicScope(scope(["same", "same"]))).toEqual(scope(["same"]));
  });

  test("accepts exactly the id length and rejects one more", () => {
    const { maxIdLength } = ACTOR_TOPIC_SCOPE_LIMITS;
    const exact = "x".repeat(maxIdLength);
    expect(parseActorTopicScope(scope([exact]))).toEqual(scope([exact]));
    // Trimmed before measuring: surrounding whitespace is not part of the id.
    expect(parseActorTopicScope(scope([` ${exact} `]))).toEqual(scope([exact]));
    const over = validateActorTopicScope(scope([`${exact}x`]));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain(`longer than ${maxIdLength}`);
  });

  test("accepts exactly the serialized byte cap and rejects one more", () => {
    const { maxSerializedBytes, maxIdLength } = ACTOR_TOPIC_SCOPE_LIMITS;
    // Build a scope whose normalized JSON lands exactly on the cap by padding
    // one last id (its quotes and separating comma cost 3 bytes), then push it
    // one byte over.
    const base = scope(ids(64, "a".repeat(120)));
    const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf-8");
    const padding = maxSerializedBytes - baseBytes - 3;
    expect(padding).toBeGreaterThan(0);
    expect(padding).toBeLessThanOrEqual(maxIdLength);
    const exact = scope([...base.visibleNodeTopicIds, "p".repeat(padding)]);
    expect(Buffer.byteLength(JSON.stringify(exact), "utf-8")).toBe(maxSerializedBytes);
    expect(parseActorTopicScope(exact)).toEqual(exact);
    const over = scope([...base.visibleNodeTopicIds, "p".repeat(padding + 1)]);
    const rejected = validateActorTopicScope(over);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain(`at most ${maxSerializedBytes}`);
    // A multi-byte id is measured in bytes, not characters.
    const wide = scope([...base.visibleNodeTopicIds, "한".repeat(Math.ceil(padding / 3) + 1)]);
    expect(parseActorTopicScope(wide)).toBeNull();
  });

  test("rejects extra keys, prototype tricks, and non-string members with a reason", () => {
    for (const [value, reason] of [
      [{ ...scope(["a"]), extra: true }, "unexpected key"],
      [
        JSON.parse('{"visibleNodeTopicIds":["a"],"ownedNodeTopicIds":[],"__proto__":{}}'),
        "unexpected key",
      ],
      [{ ...scope(["a"]), constructor: "x" }, "unexpected key"],
      [
        Object.assign(Object.create({ ownedNodeTopicIds: [] }), { visibleNodeTopicIds: ["a"] }),
        "plain object",
      ],
      [scope([1 as unknown as string]), "only strings"],
      [scope([" "]), "empty ids"],
      [{ visibleNodeTopicIds: ["a"] }, "both"],
      ["everything", "must be {"],
    ] as const) {
      const result = validateActorTopicScope(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(reason);
      expect(parseActorTopicScope(value)).toBeNull();
    }
    // Null-prototype objects (a JSON body parsed by a stricter parser) are fine.
    const bare = Object.assign(Object.create(null), scope(["a"], ["a"]));
    expect(parseActorTopicScope(bare)).toEqual(scope(["a"], ["a"]));
  });

  test("intersection keeps only what every assertion agrees on, and nothing without one", () => {
    expect(
      intersectActorTopicScopes([
        scope(["a", "b", "c"], ["b", "c"]),
        scope(["b", "c", "d"], ["c"]),
      ]),
    ).toEqual(scope(["b", "c"], ["c"]));
    expect(intersectActorTopicScopes([scope(["a"], ["a"])])).toEqual(scope(["a"], ["a"]));
    expect(intersectActorTopicScopes([scope(["a"], ["a"]), undefined])).toBeUndefined();
    expect(intersectActorTopicScopes([])).toBeUndefined();
  });
});

describe("actor topic scope freshness", () => {
  const base = { visibleNodeTopicIds: ["a"], ownedNodeTopicIds: ["a"] };

  test("issuedAt is optional, must be epoch ms, and survives argv", () => {
    expect(parseActorTopicScope({ ...base, issuedAt: 1234 })).toEqual({ ...base, issuedAt: 1234 });
    for (const issuedAt of [-1, 1.5, "1234", null, Number.NaN]) {
      expect(parseActorTopicScope({ ...base, issuedAt })).toBeNull();
    }
    const encoded = encodeActorTopicScopeArg({ ...base, issuedAt: 99 });
    expect(
      parseActorTopicScope(JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"))),
    ).toEqual({ ...base, issuedAt: 99 });
  });

  test("the node stamps on arrival; a hub stamp can only make it older", () => {
    expect(stampActorTopicScope(base, 5000)).toEqual({ ...base, issuedAt: 5000 });
    expect(stampActorTopicScope({ ...base, issuedAt: 4000 }, 5000).issuedAt).toBe(4000);
    // A future hub stamp (clock skew, bug) cannot extend the window.
    expect(stampActorTopicScope({ ...base, issuedAt: 9000 }, 5000).issuedAt).toBe(5000);
  });

  test("fresh within the window, stale after it, unstamped is stale", () => {
    const window = ACTOR_TOPIC_SCOPE_DEFAULT_MAX_AGE_MS;
    const scope = { ...base, issuedAt: 1_000_000 };
    expect(isActorTopicScopeFresh(scope, 1_000_000 + window, window)).toBe(true);
    expect(isActorTopicScopeFresh(scope, 1_000_000 + window + 1, window)).toBe(false);
    expect(isActorTopicScopeFresh(base, 1_000_000, window)).toBe(false);
    expect(isActorTopicScopeFresh({ ...base, issuedAt: 10_000_000 }, 1_000_000, window)).toBe(
      false,
    );
  });

  test("the window defaults to 10 minutes and is clamped to the token lifetime", () => {
    expect(ACTOR_TOPIC_SCOPE_DEFAULT_MAX_AGE_MS).toBe(600_000);
    expect(actorTopicScopeMaxAgeMs({})).toBe(600_000);
    expect(actorTopicScopeMaxAgeMs({ NEGOTIUM_ACTOR_TOPIC_SCOPE_MAX_AGE_MS: "0" })).toBe(0);
    expect(actorTopicScopeMaxAgeMs({ NEGOTIUM_ACTOR_TOPIC_SCOPE_MAX_AGE_MS: "60000" })).toBe(
      60_000,
    );
    expect(actorTopicScopeMaxAgeMs({ NEGOTIUM_ACTOR_TOPIC_SCOPE_MAX_AGE_MS: "-5" })).toBe(600_000);
    expect(actorTopicScopeMaxAgeMs({ NEGOTIUM_ACTOR_TOPIC_SCOPE_MAX_AGE_MS: "999999999999" })).toBe(
      ACTOR_TOPIC_SCOPE_MAX_AGE_CEILING_MS,
    );
  });

  test("a folded batch keeps the oldest stamp, and none if any request lacked one", () => {
    expect(
      intersectActorTopicScopes([
        { ...base, issuedAt: 300 },
        { ...base, issuedAt: 100 },
      ])?.issuedAt,
    ).toBe(100);
    expect(intersectActorTopicScopes([{ ...base, issuedAt: 300 }, base])?.issuedAt).toBeUndefined();
  });
});
