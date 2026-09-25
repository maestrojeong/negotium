import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  buildHostedMcpSpec,
  buildRuntimeMcpSpec,
  type HostedMcpContext,
  issueHostedMcpToken,
  issueRuntimeMcpToken,
  MCP_URL_BUDGET_CHARS,
  McpUrlBudgetExceededError,
  type RuntimeMcpContext,
  resolveHostedMcpToken,
  resolveRuntimeMcpToken,
  setRuntimeMcpPort,
} from "#mcp/runtime-spec";
import { ACTOR_TOPIC_SCOPE_LIMITS, validateActorTopicScope } from "#runtime/actor-topic-scope";
import {
  REMOTE_SESSION_GRANT_LIMITS,
  validateRemoteSessionGrant,
} from "#runtime/remote-session-grant";
import type { ActorTopicScope, RemoteSessionGrant } from "#types";

const context: HostedMcpContext = {
  userId: "local",
  topicTitle: "design",
  cwd: "/tmp/design",
  agent: "codex",
};

describe("hosted MCP runtime spec", () => {
  test("binds a signed token to one surface while allowing DM context", () => {
    const token = issueHostedMcpToken("wiki", context);
    expect(resolveHostedMcpToken(token, "wiki")).toEqual(context);
    expect(resolveHostedMcpToken(token, "vault")).toBeNull();
  });

  test("signs the actor's room assertion with the rest of the context", () => {
    const scoped: HostedMcpContext = {
      ...context,
      actorUserId: "person",
      actorTopicScope: { visibleNodeTopicIds: ["a", "b"], ownedNodeTopicIds: ["b"] },
    };
    const token = issueHostedMcpToken("session-comm", scoped);
    expect(resolveHostedMcpToken(token, "session-comm")).toEqual(scoped);
    // A token whose assertion does not validate is refused outright rather
    // than accepted with the assertion dropped.
    const [payload] = token.split(".");
    const tampered = JSON.parse(Buffer.from(payload!, "base64url").toString("utf-8"));
    tampered.ctx.actorTopicScope = { visibleNodeTopicIds: "all" };
    const forgedPayload = Buffer.from(JSON.stringify(tampered)).toString("base64url");
    expect(
      resolveHostedMcpToken(`${forgedPayload}.${token.split(".")[1]}`, "session-comm"),
    ).toBeNull();
    // Same caps as the gateway: a signed token cannot carry a larger assertion
    // than `/turns` would have accepted, however it was minted.
    const oversized = issueHostedMcpToken("session-comm", {
      ...context,
      actorTopicScope: {
        visibleNodeTopicIds: Array.from({ length: 201 }, (_, i) => `n-${i}`),
        ownedNodeTopicIds: [],
      },
    });
    expect(resolveHostedMcpToken(oversized, "session-comm")).toBeNull();
  });

  test("rejects a modified signature", () => {
    const token = issueHostedMcpToken("task", context);
    const replacement = token.endsWith("a") ? "b" : "a";
    const forged = `${token.slice(0, -1)}${replacement}`;
    expect(resolveHostedMcpToken(forged, "task")).toBeNull();
  });

  test("builds streamable HTTP for Codex and SSE for other agents", () => {
    setRuntimeMcpPort(45678);
    const codex = buildHostedMcpSpec("codex", "task", context);
    const claude = buildHostedMcpSpec("claude", "task", { ...context, agent: "claude" });

    expect(String(codex.url)).toStartWith("http://127.0.0.1:45678/mcp/runtime/task/mcp?token=");
    expect(claude.type).toBe("sse");
    expect(String(claude.url)).toStartWith("http://127.0.0.1:45678/mcp/runtime/task/sse?token=");
    expect(claude.cacheKey).toBeUndefined();
    expect(claude.lifecycle).toBeUndefined();
  });

  test("gives Maestro a stable semantic identity independent of per-turn tokens", () => {
    const first = buildHostedMcpSpec("maestro", "wiki", {
      ...context,
      agent: "maestro",
      topicId: "topic-1",
      queryId: "query-1",
    });
    const second = buildHostedMcpSpec("maestro", "wiki", {
      ...context,
      agent: "maestro",
      topicId: "topic-1",
      queryId: "query-2",
    });

    expect(first.lifecycle).toBe("process");
    expect(first.cacheKey).toBe(second.cacheKey);
    expect(first.cacheKey).toStartWith("hosted:wiki:");
    expect(first.url).not.toBe(second.url);
  });

  test("keeps context-sensitive hosted identities isolated", () => {
    const first = buildHostedMcpSpec("maestro", "task", {
      ...context,
      agent: "maestro",
      topicId: "topic-1",
    });
    const second = buildHostedMcpSpec("maestro", "task", {
      ...context,
      agent: "maestro",
      topicId: "topic-2",
    });
    expect(first.cacheKey).not.toBe(second.cacheKey);
  });

  test("marks normal session-comm as session state and query-bound bridges as turn state", () => {
    const normal = buildHostedMcpSpec("maestro", "session-comm", {
      ...context,
      agent: "maestro",
      topicId: "topic-1",
    });
    const replyOnly = buildHostedMcpSpec("maestro", "session-comm", {
      ...context,
      agent: "maestro",
      topicId: "topic-1",
      silent: true,
    });

    expect(normal.lifecycle).toBe("session");
    expect(replyOnly.lifecycle).toBe("turn");
  });
});

/**
 * The largest assertion `validateActorTopicScope` admits with UUID ids: 200
 * visible (the per-list cap) plus as many owned as still fit in 8 KiB.
 */
function maximalScope(): ActorTopicScope {
  const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
  let owned = ACTOR_TOPIC_SCOPE_LIMITS.maxIdsPerList;
  for (;;) {
    const scope = { visibleNodeTopicIds: ids(200), ownedNodeTopicIds: ids(owned) };
    if (validateActorTopicScope(scope).ok) return scope;
    owned -= 1;
  }
}

function tokenOf(spec: Record<string, unknown>): string {
  return decodeURIComponent(String(spec.url).split("?token=")[1] ?? "");
}

/** Every optional runtime field at a realistic maximum, plus the maximal assertion. */
function fullRuntimeContext(scope: ActorTopicScope): RuntimeMcpContext {
  return {
    userId: "local",
    actorUserId: randomUUID(),
    actorTopicScope: scope,
    topicId: randomUUID(),
    topicTitle: "t".repeat(64),
    queryId: randomUUID(),
    cwd: `/Users/someone/.negotium/workspace/topics/${randomUUID()}`,
    agent: "claude",
    model: "claude-opus-4-1-20250805",
    explicitAgentSwitchTargets: ["maestro", "claude", "codex"],
    autoContinue: true,
    visualTools: true,
    fileDeliveryTools: true,
    threadRootId: randomUUID(),
    peerBridge: {
      hubCellId: randomUUID(),
      hostTopicId: randomUUID(),
      hostQueryId: randomUUID(),
      canSpawnSubagents: true,
    },
  };
}

/** The largest grant `validateRemoteSessionGrant` admits: a 512-char https hub URL and a 2 KiB capability. */
function maximalGrant(): RemoteSessionGrant {
  const hubUrl = `https://${"h".repeat(REMOTE_SESSION_GRANT_LIMITS.maxHubUrlLength - "https://".length - 8)}.example`;
  const capability = `rsc1.${"c".repeat(REMOTE_SESSION_GRANT_LIMITS.maxCapabilityLength - 5 - 44)}.${"s".repeat(43)}`;
  const grant = { hubUrl, capability };
  const validated = validateRemoteSessionGrant(grant);
  if (!validated.ok) throw new Error(validated.error);
  return grant;
}

/** A grant the size the hub actually issues (≈400-character capability). */
function realisticGrant(): RemoteSessionGrant {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      t: "rsc",
      j: randomUUID().replace(/-/g, "").slice(0, 22),
      a: randomUUID(),
      c: randomUUID(),
      h: randomUUID(),
      n: randomUUID(),
      q: randomUUID(),
      i: 1_800_000_000,
      e: 1_800_014_400,
    }),
  ).toString("base64url");
  return {
    hubUrl: "https://hub.example.com:8443",
    capability: `rsc1.${payload}.${"s".repeat(43)}`,
  };
}

describe("built-in MCP URL budget", () => {
  test("the session-comm token carries the remote-session grant and stays within budget with the maximal assertion", () => {
    setRuntimeMcpPort(65_535);
    const scope = maximalScope();
    const base: HostedMcpContext = {
      userId: "local",
      actorUserId: randomUUID(),
      actorTopicScope: scope,
      topicTitle: "t".repeat(64),
      topicId: randomUUID(),
      queryId: randomUUID(),
      wikiTopicId: randomUUID(),
      subagentParentTopicId: randomUUID(),
      cwd: `/Users/someone/.negotium/workspace/topics/${randomUUID()}`,
      agent: "claude",
      model: "claude-opus-4-1-20250805",
      depth: 3,
      silent: true,
      threadRootId: randomUUID(),
      peerBridge: {
        hubCellId: randomUUID(),
        hostTopicId: randomUUID(),
        hostQueryId: randomUUID(),
        canSpawnSubagents: true,
      },
    };
    const without = String(buildHostedMcpSpec("claude", "session-comm", base).url).length;
    const sizes: Record<string, number | string> = { budget: MCP_URL_BUDGET_CHARS, without };
    // The grant the hub actually issues (≈440-character capability) fits
    // beside the maximal assertion for every agent, with room to spare.
    const realistic = realisticGrant();
    sizes.realisticCapability = realistic.capability.length;
    for (const agent of ["claude", "codex", "maestro"] as const) {
      const spec = buildHostedMcpSpec(agent, "session-comm", {
        ...base,
        agent,
        remoteSession: realistic,
      });
      const length = String(spec.url).length;
      sizes[`maxAssertion+realistic:${agent}`] = length;
      expect(length).toBeLessThanOrEqual(MCP_URL_BUDGET_CHARS);
      const resolved = resolveHostedMcpToken(tokenOf(spec), "session-comm");
      expect(resolved?.remoteSession).toEqual(realistic);
      expect(resolved?.actorTopicScope).toEqual(scope);
    }
    expect(Number(sizes["maxAssertion+realistic:claude"]) - without).toBeLessThan(800);
    // A grant at both caps (512-char hub URL, 2 KiB capability) fits on its
    // own and beside a typical assertion...
    const maximal = maximalGrant();
    const noAssertion = buildHostedMcpSpec("claude", "session-comm", {
      ...base,
      actorTopicScope: undefined,
      remoteSession: maximal,
    });
    sizes["noAssertion+maximal"] = String(noAssertion.url).length;
    expect(String(noAssertion.url).length).toBeLessThanOrEqual(MCP_URL_BUDGET_CHARS);
    expect(resolveHostedMcpToken(tokenOf(noAssertion), "session-comm")?.remoteSession).toEqual(
      maximal,
    );
    // ...but not beside the *maximal* assertion (measured: 15,593 characters,
    // ~1.3 KB over). That combination is refused by the hard check at mint
    // time rather than minted narrower: nothing is dropped, the turn's MCP
    // setup fails loudly. The largest capability that still fits beside a
    // maximal assertion is ≈1,590 characters — a hub that keeps its
    // capabilities near the designed ≈400 never gets close.
    try {
      buildHostedMcpSpec("claude", "session-comm", { ...base, remoteSession: maximal });
      throw new Error(
        "expected the maximal grant beside the maximal assertion to exceed the budget",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(McpUrlBudgetExceededError);
      sizes["maxAssertion+maximal"] =
        `refused at ${(error as McpUrlBudgetExceededError).urlLength}`;
    }
    // The hub's issue-time hard cap is 1 KiB: a capability at that cap with
    // the hub URL at its own 512-char cap still fits beside the maximal
    // assertion for every agent, so a hub that honours its cap never trips
    // the budget check.
    const hubCap: RemoteSessionGrant = {
      hubUrl: maximal.hubUrl,
      capability: `rsc1.${"c".repeat(1024 - 5 - 44)}.${"s".repeat(43)}`,
    };
    expect(hubCap.capability.length).toBe(1024);
    for (const agent of ["claude", "codex", "maestro"] as const) {
      const spec = buildHostedMcpSpec(agent, "session-comm", {
        ...base,
        agent,
        remoteSession: hubCap,
      });
      sizes[`maxAssertion+hubCap1KiB+maxHubUrl:${agent}`] = String(spec.url).length;
      expect(String(spec.url).length).toBeLessThanOrEqual(MCP_URL_BUDGET_CHARS);
    }
    // Keep the measurement visible in the run.
    console.info(`[remote-session] session-comm URL sizes: ${JSON.stringify(sizes)}`);
    // The grant is inside the signed payload: rewriting it breaks the signature.
    const spec = buildHostedMcpSpec("claude", "session-comm", {
      ...base,
      remoteSession: realisticGrant(),
    });
    const [payload, signature] = tokenOf(spec).split(".");
    const tampered = JSON.parse(Buffer.from(payload!, "base64url").toString("utf-8"));
    tampered.ctx.remoteSession = { hubUrl: "https://evil.example", capability: "rsc1.a.b" };
    const forged = Buffer.from(JSON.stringify(tampered)).toString("base64url");
    expect(resolveHostedMcpToken(`${forged}.${signature}`, "session-comm")).toBeNull();
    // A token minted with a malformed grant is refused rather than read.
    const minted = issueHostedMcpToken("session-comm", {
      ...base,
      remoteSession: { hubUrl: "http://hub.example", capability: "rsc1.a.b" },
    });
    expect(resolveHostedMcpToken(minted, "session-comm")).toBeNull();
    // A grant past the hosted cap on top of the maximal assertion is what the
    // hard check is for: it refuses rather than minting a URL that will 431.
    expect(() =>
      buildHostedMcpSpec("claude", "session-comm", {
        ...base,
        cwd: `${base.cwd}${"x".repeat(2_000)}`,
        remoteSession: maximalGrant(),
      }),
    ).toThrow(McpUrlBudgetExceededError);
  });

  test("the runtime token carries the derived switch targets, never the prompt", () => {
    const ctx: RuntimeMcpContext = {
      ...fullRuntimeContext(maximalScope()),
      explicitAgentSwitchTargets: ["codex"],
    };
    const token = issueRuntimeMcpToken(ctx);
    expect(resolveRuntimeMcpToken(token)).toEqual(ctx);
    expect(token).not.toContain("currentUserPrompt");
    // The field is inside the signed payload: an agent that rewrites it to
    // grant itself a switch invalidates the signature.
    const [payload, signature] = token.split(".");
    const tampered = JSON.parse(Buffer.from(payload!, "base64url").toString("utf-8"));
    tampered.ctx.explicitAgentSwitchTargets = ["maestro"];
    const forged = Buffer.from(JSON.stringify(tampered)).toString("base64url");
    expect(resolveRuntimeMcpToken(`${forged}.${signature}`)).toBeNull();
    // And a token minted with a malformed value is refused rather than read.
    for (const bad of [["codex", "codex"], ["gpt"], "codex", ["codex", "claude", "maestro", "x"]]) {
      const minted = issueRuntimeMcpToken({
        ...ctx,
        explicitAgentSwitchTargets:
          bad as unknown as RuntimeMcpContext["explicitAgentSwitchTargets"],
      });
      expect(resolveRuntimeMcpToken(minted)).toBeNull();
    }
  });

  test("the whole runtime URL stays within budget with every field and the maximal assertion", () => {
    setRuntimeMcpPort(65_535);
    const scope = maximalScope();
    const ctx = fullRuntimeContext(scope);
    for (const agent of ["claude", "codex", "maestro"] as const) {
      const spec = buildRuntimeMcpSpec(agent, { ...ctx, agent });
      expect(String(spec.url).length).toBeLessThanOrEqual(MCP_URL_BUDGET_CHARS);
      const resolved = resolveRuntimeMcpToken(tokenOf(spec));
      expect(resolved?.actorTopicScope).toEqual(scope);
      expect(resolved?.actorUserId).toBe(ctx.actorUserId);
      expect(resolved?.explicitAgentSwitchTargets).toEqual(ctx.explicitAgentSwitchTargets);
    }
  });

  test("the hosted URL with the maximal assertion stays within budget", () => {
    setRuntimeMcpPort(65_535);
    const scope = maximalScope();
    const ctx: HostedMcpContext = {
      userId: "local",
      actorUserId: randomUUID(),
      actorTopicScope: scope,
      topicTitle: "t".repeat(64),
      topicId: randomUUID(),
      queryId: randomUUID(),
      wikiTopicId: randomUUID(),
      subagentParentTopicId: randomUUID(),
      cwd: `/Users/someone/.negotium/workspace/topics/${randomUUID()}`,
      agent: "claude",
      model: "claude-opus-4-1-20250805",
      depth: 3,
      silent: true,
      threadRootId: randomUUID(),
      peerBridge: {
        hubCellId: randomUUID(),
        hostTopicId: randomUUID(),
        hostQueryId: randomUUID(),
        canSpawnSubagents: true,
      },
    };
    const spec = buildHostedMcpSpec("claude", "session-comm", ctx);
    expect(String(spec.url).length).toBeLessThanOrEqual(MCP_URL_BUDGET_CHARS);
    expect(resolveHostedMcpToken(tokenOf(spec), "session-comm")?.actorTopicScope).toEqual(scope);
  });

  test("exactly the budget is accepted; one step over refuses, nothing is dropped", () => {
    setRuntimeMcpPort(65_535);
    const scope = maximalScope();
    const base = fullRuntimeContext(scope);
    // Grow the cwd one byte at a time until the URL is as long as it can be
    // without crossing the budget (base64url grows in 4/3 steps, so every
    // length is reachable except those ≡ 1 mod 4 from the fixed part).
    let cwd = base.cwd;
    let lastWithin = buildRuntimeMcpSpec("claude", { ...base, cwd });
    for (;;) {
      const next = `${cwd}x`;
      let spec: Record<string, unknown>;
      try {
        spec = buildRuntimeMcpSpec("claude", { ...base, cwd: next });
      } catch (error) {
        expect(error).toBeInstanceOf(McpUrlBudgetExceededError);
        break;
      }
      cwd = next;
      lastWithin = spec;
    }
    const within = String(lastWithin.url).length;
    expect(within).toBeLessThanOrEqual(MCP_URL_BUDGET_CHARS);
    expect(MCP_URL_BUDGET_CHARS - within).toBeLessThanOrEqual(1);
    const resolved = resolveRuntimeMcpToken(tokenOf(lastWithin));
    expect(resolved?.actorTopicScope).toEqual(scope);
    expect(resolved?.explicitAgentSwitchTargets).toEqual(base.explicitAgentSwitchTargets);

    // Over budget: refused, never minted narrower (no assertion, no switch
    // target is ever dropped to make it fit).
    expect(() => buildRuntimeMcpSpec("claude", { ...base, cwd: `${cwd}xxxx` })).toThrow(
      McpUrlBudgetExceededError,
    );
    expect(() =>
      buildHostedMcpSpec("claude", "session-comm", { ...base, cwd: `${cwd}${"x".repeat(2_000)}` }),
    ).toThrow(McpUrlBudgetExceededError);
  });
});
