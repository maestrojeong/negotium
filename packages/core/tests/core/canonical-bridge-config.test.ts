import { describe, expect, test } from "bun:test";
import {
  canonicalMcpBridgeEnv,
  registerCanonicalMcpBridgeEnvProvider,
} from "#mcp/canonical-bridge-config";

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
    const disposeA = registerCanonicalMcpBridgeEnvProvider(() => ({ owner: "a" }));
    const disposeB = registerCanonicalMcpBridgeEnvProvider(() => ({ owner: "b" }));
    expect(canonicalMcpBridgeEnv(scope)).toEqual({ owner: "b" });
    disposeA();
    expect(canonicalMcpBridgeEnv(scope)).toEqual({ owner: "b" });
    disposeB();
    expect(canonicalMcpBridgeEnv(scope)).toBeUndefined();

    const disposeC = registerCanonicalMcpBridgeEnvProvider(() => ({ owner: "c" }));
    const disposeD = registerCanonicalMcpBridgeEnvProvider(() => ({ owner: "d" }));
    expect(canonicalMcpBridgeEnv(scope)).toEqual({ owner: "d" });
    disposeD();
    expect(canonicalMcpBridgeEnv(scope)).toEqual({ owner: "c" });
    disposeC();
    expect(canonicalMcpBridgeEnv(scope)).toBeUndefined();
  });
});
