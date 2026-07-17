import { describe, expect, test } from "bun:test";
import { runHostedAgent } from "#agents/hosted-agent";
import {
  canonicalMcpBridgeEnv,
  registerCanonicalMcpBridgeEnvProvider,
  revokeCanonicalMcpBridgeTurn,
} from "#mcp/canonical-bridge-config";
import type { AgentQueryOptions } from "#types";

const scope = {
  surface: "task" as const,
  userId: "u",
  topicId: "worker-topic",
  queryId: "worker-query",
  peerBridge: {
    hubCellId: "hub",
    hostTopicId: "hub-topic",
    hostQueryId: "hub-query",
    canSpawnSubagents: false,
  },
};

describe("canonical MCP bridge provider registry", () => {
  test("restores the previous provider across nested and out-of-order disposal", () => {
    const disposeA = registerCanonicalMcpBridgeEnvProvider(() => ({
      env: { owner: "a" },
      revoke: () => undefined,
    }));
    const disposeB = registerCanonicalMcpBridgeEnvProvider(() => ({
      env: { owner: "b" },
      revoke: () => undefined,
    }));
    expect(canonicalMcpBridgeEnv(scope)).toEqual({ owner: "b" });
    disposeA();
    expect(canonicalMcpBridgeEnv(scope)).toEqual({ owner: "b" });
    disposeB();
    expect(canonicalMcpBridgeEnv(scope)).toBeUndefined();

    const disposeC = registerCanonicalMcpBridgeEnvProvider(() => ({
      env: { owner: "c" },
      revoke: () => undefined,
    }));
    const disposeD = registerCanonicalMcpBridgeEnvProvider(() => ({
      env: { owner: "d" },
      revoke: () => undefined,
    }));
    expect(canonicalMcpBridgeEnv(scope)).toEqual({ owner: "d" });
    disposeD();
    expect(canonicalMcpBridgeEnv(scope)).toEqual({ owner: "c" });
    disposeC();
    expect(canonicalMcpBridgeEnv(scope)).toBeUndefined();
  });

  test("revokes every task/wiki capability issued for a turn exactly once", () => {
    const leaseScope = { ...scope, queryId: "leased-worker-query" };
    let revoked = 0;
    const dispose = registerCanonicalMcpBridgeEnvProvider(() => ({
      env: { owner: "leased" },
      revoke: () => {
        revoked += 1;
      },
    }));
    expect(canonicalMcpBridgeEnv(leaseScope)).toEqual({ owner: "leased" });
    expect(canonicalMcpBridgeEnv({ ...leaseScope, surface: "wiki" })).toEqual({ owner: "leased" });

    expect(revokeCanonicalMcpBridgeTurn(leaseScope)).toBe(2);
    expect(revoked).toBe(2);
    expect(revokeCanonicalMcpBridgeTurn(leaseScope)).toBe(0);
    expect(revoked).toBe(2);
    dispose();
  });

  test("hosted execution revokes issued capabilities even when provider dispatch throws", async () => {
    let revoked = 0;
    const dispose = registerCanonicalMcpBridgeEnvProvider(() => ({
      env: { owner: "hosted-turn" },
      revoke: () => {
        revoked += 1;
      },
    }));
    expect(canonicalMcpBridgeEnv(scope)).toEqual({ owner: "hosted-turn" });

    const iterator = runHostedAgent({
      agent: "invalid",
      cwd: "/tmp",
      prompt: "hello",
      userId: scope.userId,
      topicId: scope.topicId,
      queryId: scope.queryId,
      peerBridge: scope.peerBridge,
    } as unknown as AgentQueryOptions);
    await expect(iterator.next()).rejects.toThrow("unknown agent");
    expect(revoked).toBe(1);
    dispose();
  });
});
