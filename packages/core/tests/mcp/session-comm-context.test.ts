import { describe, expect, test } from "bun:test";
import { parseSessionCommContext } from "#mcp/session-comm/context";
import { encodeRemoteSessionGrantArg } from "#runtime/remote-session-grant";

describe("parseSessionCommContext", () => {
  test("parses an explicit standalone context", () => {
    expect(
      parseSessionCommContext(
        [
          "--user-id=user",
          "--topic=Room",
          "--topic-id=id",
          "--subagent-parent-topic-id=parent-id",
          "--peer-host-query-id=query",
          "--depth=2",
          "--reply-only=true",
          "--agent=codex",
        ],
        { userId: "default", agent: "claude" },
      ),
    ).toEqual({
      userId: "user",
      currentTopic: "Room",
      currentTopicId: "id",
      subagentParentTopicId: "parent-id",
      peerHostQueryId: "query",
      depth: 2,
      replyOnly: true,
      agent: "codex",
    });
  });

  test("uses caller defaults and rejects invalid process values", () => {
    expect(parseSessionCommContext([], { userId: "default", agent: "maestro" })).toEqual({
      userId: "default",
      currentTopic: "",
      currentTopicId: undefined,
      subagentParentTopicId: undefined,
      peerHostQueryId: undefined,
      depth: 0,
      replyOnly: false,
      agent: "maestro",
    });
    expect(() =>
      parseSessionCommContext(["--depth=-1"], { userId: "default", agent: "claude" }),
    ).toThrow("Invalid --depth");
    expect(() =>
      parseSessionCommContext(["--agent=unknown"], { userId: "default", agent: "claude" }),
    ).toThrow("Invalid --agent");
  });

  test("carries the node's assertion freshness window for the stdio child", () => {
    const defaults = { userId: "default", agent: "claude" } as const;
    expect(
      parseSessionCommContext(["--actor-topic-scope-max-age-ms=60000"], defaults)
        .actorTopicScopeMaxAgeMs,
    ).toBe(60_000);
    expect(parseSessionCommContext([], defaults).actorTopicScopeMaxAgeMs).toBeUndefined();
    expect(
      parseSessionCommContext(["--actor-topic-scope-max-age-ms=99999999999"], defaults)
        .actorTopicScopeMaxAgeMs,
    ).toBe(4 * 60 * 60 * 1000);
    expect(() => parseSessionCommContext(["--actor-topic-scope-max-age-ms=-1"], defaults)).toThrow(
      "Invalid --actor-topic-scope-max-age-ms arg",
    );
  });

  test("carries the hub's actor assertion for the otium surface", () => {
    const scope = { visibleNodeTopicIds: ["v"], ownedNodeTopicIds: ["v"] };
    const encoded = Buffer.from(JSON.stringify(scope), "utf-8").toString("base64url");
    const context = parseSessionCommContext(
      ["--user-id=local", "--actor-user-id=person", `--actor-topic-scope=${encoded}`],
      { userId: "default", agent: "claude" },
    );
    expect(context.actorUserId).toBe("person");
    expect(context.actorTopicScope).toEqual(scope);
    expect(
      parseSessionCommContext([], { userId: "default", agent: "claude" }).actorTopicScope,
    ).toBeUndefined();
    // A malformed assertion is a broken launch, never "no assertion".
    expect(() =>
      parseSessionCommContext(["--actor-topic-scope=not-json"], {
        userId: "default",
        agent: "claude",
      }),
    ).toThrow("Invalid --actor-topic-scope arg");
    const wrongShape = Buffer.from(JSON.stringify({ visibleNodeTopicIds: "v" })).toString(
      "base64url",
    );
    expect(() =>
      parseSessionCommContext([`--actor-topic-scope=${wrongShape}`], {
        userId: "default",
        agent: "claude",
      }),
    ).toThrow("Invalid --actor-topic-scope arg");
    // The argv path enforces the same caps as the gateway and the tokens.
    const oversized = Buffer.from(
      JSON.stringify({
        visibleNodeTopicIds: Array.from({ length: 201 }, (_, i) => `n-${i}`),
        ownedNodeTopicIds: [],
      }),
    ).toString("base64url");
    expect(() =>
      parseSessionCommContext([`--actor-topic-scope=${oversized}`], {
        userId: "default",
        agent: "claude",
      }),
    ).toThrow("Invalid --actor-topic-scope arg");
  });

  test("parses and validates the hub's remote-session grant", () => {
    const grant = { hubUrl: "https://hub.example", capability: "rsc1.cGF5bG9hZA.c2lnbmF0dXJl" };
    const encoded = encodeRemoteSessionGrantArg(grant);
    expect(
      parseSessionCommContext([`--remote-session-grant=${encoded}`], {
        userId: "default",
        agent: "claude",
      }).remoteSession,
    ).toEqual(grant);
    // Absent means absent — never an empty or default grant.
    expect(
      "remoteSession" in parseSessionCommContext([], { userId: "default", agent: "claude" }),
    ).toBe(false);
    for (const bad of [
      "not-base64",
      Buffer.from(
        JSON.stringify({ hubUrl: "http://hub.example", capability: "rsc1.a.b" }),
      ).toString("base64url"),
      Buffer.from(JSON.stringify({ hubUrl: "https://hub.example", capability: "x.y.z" })).toString(
        "base64url",
      ),
    ]) {
      expect(() =>
        parseSessionCommContext([`--remote-session-grant=${bad}`], {
          userId: "default",
          agent: "claude",
        }),
      ).toThrow("Invalid --remote-session-grant");
    }
  });
});
