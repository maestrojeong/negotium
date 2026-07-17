import { describe, expect, test } from "bun:test";
import {
  peerSessionBridgeIpcEnv,
  registerPeerSessionBridgeIpcConfig,
} from "#mcp/session-comm/bridge-ipc-config";

describe("peer session bridge IPC registration", () => {
  test("does not resurrect an already disposed registration", () => {
    const stopFirst = registerPeerSessionBridgeIpcConfig({ url: "http://127.0.0.1:1", token: "a" });
    const stopSecond = registerPeerSessionBridgeIpcConfig({
      url: "http://127.0.0.1:2",
      token: "b",
    });
    expect(peerSessionBridgeIpcEnv()?.NEGOTIUM_PEER_SESSION_BRIDGE_TOKEN).toBe("b");
    stopFirst();
    expect(peerSessionBridgeIpcEnv()?.NEGOTIUM_PEER_SESSION_BRIDGE_TOKEN).toBe("b");
    stopSecond();
    expect(peerSessionBridgeIpcEnv()).toBeUndefined();
  });
});
