import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import "#storage/api-topics";
import { isPortInUse, reserveAvailableLoopbackPort } from "#platform/playwright/browser-processes";
import {
  browserProcessMatchesExpectedProfile,
  configurePlaywrightManagerHost,
  extractUserDataDirArg,
  getPlaywrightManagerHost,
  isBrowserJanitorOwner,
  isLiveOwnedChildProcess,
  makeInstanceKey,
  matchesSpawnedBrowserHealth,
  pinPlaywrightInstance,
  reapPlaywrightOrphans,
  resetPlaywrightManagerHost,
  resolvePlaywrightTopicBinding,
  resolveTopicProfileDir,
  selectIdleEvictionKey,
  selectOrphanBrowserPids,
  selectReusablePort,
  unpinPlaywrightInstance,
  waitForChildProcessExit,
  waitForChildProcessSpawnError,
  watchChildStartup,
  withPlaywrightInstanceMaintenance,
  withPlaywrightProfileMaintenance,
} from "#platform/playwright/manager";
import { probeMcpTransport } from "#platform/playwright/transport-probe";

function stubMcpTransport(options: { tools?: string[]; listError?: boolean } = {}): Transport {
  const transport: Transport = {
    async start() {},
    async close() {
      transport.onclose?.();
    },
    async send(message: JSONRPCMessage) {
      if (!("method" in message) || !("id" in message)) return;
      queueMicrotask(() => {
        if (message.method === "initialize") {
          transport.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "probe-test", version: "1" },
            },
          });
          return;
        }
        if (message.method === "tools/list") {
          transport.onmessage?.(
            options.listError
              ? {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32603, message: "tools unavailable" },
                }
              : {
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    tools: (options.tools ?? ["browser_status"]).map((name) => ({
                      name,
                      description: name,
                      inputSchema: { type: "object" },
                    })),
                  },
                },
          );
        }
      });
    },
  };
  return transport;
}

describe("probeMcpTransport", () => {
  it("requires initialize, tools/list, and optional session cleanup", async () => {
    let terminated = false;
    expect(
      await probeMcpTransport(stubMcpTransport(), {
        terminate: async () => {
          terminated = true;
        },
      }),
    ).toBe(true);
    expect(terminated).toBe(true);
  });

  it("rejects a transport whose tools/list request fails", async () => {
    expect(await probeMcpTransport(stubMcpTransport({ listError: true }))).toBe(false);
  });

  it("rejects a transport that initializes without browser tools", async () => {
    expect(await probeMcpTransport(stubMcpTransport({ tools: [] }))).toBe(false);
  });
});

describe("loopback browser port ownership", () => {
  it("detects an occupied port without relying on lsof or PATH", async () => {
    const server = createServer();
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");

    expect(await isPortInUse(address.port)).toBe(true);

    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
    expect(await isPortInUse(address.port)).toBe(false);
  });

  it("rejects a healthy foreign browser gateway without the exact spawn nonce", () => {
    const foreign = {
      ok: true,
      name: "negotium-browser-gateway",
      spawnNonce: "foreign-spawn",
    };
    expect(matchesSpawnedBrowserHealth(foreign, "expected-spawn")).toBe(false);
    expect(
      matchesSpawnedBrowserHealth({ ...foreign, spawnNonce: "expected-spawn" }, "expected-spawn"),
    ).toBe(true);
  });

  it("skips both a real instance and a foreign lookalike before reserving the next port", async () => {
    const reserved = new Set<number>();
    const occupied = new Set([9100, 9101]);
    const port = await reserveAvailableLoopbackPort(9100, 9102, reserved, async (candidate) =>
      occupied.has(candidate),
    );

    expect(port).toBe(9102);
    expect([...reserved]).toEqual([9102]);
  });
});

describe("isBrowserJanitorOwner", () => {
  it("only lets the current node-daemon lease owner reap shared browser processes", () => {
    expect(isBrowserJanitorOwner(42, 42)).toBe(true);
    expect(isBrowserJanitorOwner(42, 41)).toBe(false);
    expect(isBrowserJanitorOwner(null, 42)).toBe(false);
  });
});

describe("extractUserDataDirArg", () => {
  it("parses space-form cmdline as emitted by playwright-mcp spawn", () => {
    const cmd =
      "/usr/bin/node /path/playwright-mcp --port 9100 --host 127.0.0.1 " +
      "--user-data-dir /Users/me/.playwright/-42_topic --shared-browser-context " +
      "--browser chrome --init-script /path/stealth.js";
    expect(extractUserDataDirArg(cmd)).toBe("/Users/me/.playwright/-42_topic");
  });

  it("parses equals-form cmdline (lenient fallback)", () => {
    const cmd =
      "node playwright-mcp --port=9100 --user-data-dir=/var/profiles/abc --browser chrome";
    expect(extractUserDataDirArg(cmd)).toBe("/var/profiles/abc");
  });

  it("returns null when the flag is absent", () => {
    const cmd = "node playwright-mcp --port 9100 --browser chrome";
    expect(extractUserDataDirArg(cmd)).toBeNull();
  });

  it("returns null on a non-playwright cmdline", () => {
    expect(extractUserDataDirArg("bun run /path/scripts/task.ts")).toBeNull();
  });

  it("returns the first occurrence when the flag appears twice", () => {
    // Defensive: spawn never emits this, but the regex should still pick a
    // deterministic value rather than mixing inputs.
    const cmd = "playwright-mcp --user-data-dir /first --user-data-dir /second";
    expect(extractUserDataDirArg(cmd)).toBe("/first");
  });
});

describe("makeInstanceKey", () => {
  it("falls back to the caller's default profile for unknown synthetic topics", () => {
    expect(makeInstanceKey("alice", "topic-123")).toBe("profile:alice:default");
    expect(makeInstanceKey("bob", "topic-123")).toBe("profile:bob:default");
  });

  it("uses a user-scoped default profile for dm", () => {
    expect(makeInstanceKey("alice", undefined)).toBe("profile:alice:default");
  });
});

describe("configurePlaywrightManagerHost", () => {
  it("injects product-specific profile paths and child environment", () => {
    try {
      configurePlaywrightManagerHost({
        portsDir: "/tmp/otium-browser-ports",
        resolveTopicBinding(userId, topic) {
          const profile = topic ?? "default";
          return {
            instanceKey: `otium:${userId}:${profile}`,
            ownerId: userId,
            profile,
          };
        },
        resolveInstanceDataDir(instanceKey) {
          const [, userId, profile] = instanceKey.split(":");
          return `/tmp/otium-browser-profiles/${userId}/${profile}`;
        },
        createChildEnvironment(context) {
          return {
            ...context.environment,
            OTIUM_BROWSER_VAULT_TOKEN: context.capability,
          };
        },
        cleanupBrowserProcessesForDataDir() {},
        reapOrphanBrowsers() {},
      });

      expect(makeInstanceKey("alice", "research")).toBe("otium:alice:research");
      expect(resolveTopicProfileDir("alice", "research")).toBe(
        "/tmp/otium-browser-profiles/alice/research",
      );
      const host = getPlaywrightManagerHost();
      expect(host.portsDir).toBe("/tmp/otium-browser-ports");
      expect(
        host.createChildEnvironment({
          instanceKey: "otium:alice:research",
          ownerId: "alice",
          capability: "secret",
          proxy: null,
          environment: {},
        }).OTIUM_BROWSER_VAULT_TOKEN,
      ).toBe("secret");
      expect(Object.isFrozen(host)).toBe(true);
      expect(() => Object.assign(host, { basePort: 1 })).toThrow();
    } finally {
      resetPlaywrightManagerHost();
    }
  });

  it("preserves the canonical binding owner instead of the requesting user", () => {
    try {
      configurePlaywrightManagerHost({
        resolveTopicBinding(_userId, topic) {
          return {
            instanceKey: `shared:${topic ?? "default"}`,
            ownerId: "profile-owner",
            profile: topic ?? "default",
          };
        },
      });

      expect(resolvePlaywrightTopicBinding("requesting-user", "research")).toEqual({
        instanceKey: "shared:research",
        ownerId: "profile-owner",
        profile: "research",
      });
    } finally {
      resetPlaywrightManagerHost();
    }
  });

  it("composes the default topic resolver with an injected named-profile resolver", () => {
    try {
      configurePlaywrightManagerHost({
        resolveNamedBinding(ownerId, profile) {
          return {
            instanceKey: `custom:${ownerId}:${profile}`,
            ownerId,
            profile,
          };
        },
      });

      expect(makeInstanceKey("alice", undefined)).toBe("custom:alice:default");
    } finally {
      resetPlaywrightManagerHost();
    }
  });

  it("merges consecutive partial configurations and rejects changes while borrowed", () => {
    try {
      configurePlaywrightManagerHost({ portsDir: "/tmp/custom-browser-ports" });
      configurePlaywrightManagerHost({ basePort: 9200, maxPort: 9201 });
      expect(getPlaywrightManagerHost().portsDir).toBe("/tmp/custom-browser-ports");

      pinPlaywrightInstance("custom:borrowed");
      expect(() => configurePlaywrightManagerHost({ basePort: 9300 })).toThrow(
        "cannot configure Playwright manager while browser instances are active",
      );
    } finally {
      unpinPlaywrightInstance("custom:borrowed");
      resetPlaywrightManagerHost();
    }
  });

  it("runs explicit orphan sweeps through the injected host", () => {
    const sweeps: string[][] = [];
    try {
      configurePlaywrightManagerHost({
        reapOrphanBrowsers(liveUserDataDirs) {
          sweeps.push([...liveUserDataDirs]);
        },
      });

      reapPlaywrightOrphans();
      expect(sweeps).toEqual([[]]);
    } finally {
      resetPlaywrightManagerHost();
    }
  });

  it("rejects invalid injected port ranges", () => {
    expect(() => configurePlaywrightManagerHost({ basePort: 9300, maxPort: 9200 })).toThrow(
      "invalid Playwright manager port range",
    );
    resetPlaywrightManagerHost();
  });

  it("rejects custom profile paths without matching cleanup hooks", () => {
    expect(() =>
      configurePlaywrightManagerHost({
        resolveInstanceDataDir(instanceKey) {
          return `/tmp/custom-browser-profiles/${instanceKey}`;
        },
      }),
    ).toThrow("custom Playwright profile paths require host crash cleanup and orphan sweep hooks");
    resetPlaywrightManagerHost();
  });
});

describe("withPlaywrightInstanceMaintenance", () => {
  it("only allows stopping instances covered by the maintenance barrier", async () => {
    await expect(
      withPlaywrightInstanceMaintenance(["profile:a"], ({ stopInstance }) =>
        stopInstance("profile:b"),
      ),
    ).rejects.toThrow('Playwright maintenance does not own instance "profile:b"');
  });

  it("serializes operations that overlap on any profile key", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withPlaywrightInstanceMaintenance(["profile:a", "profile:b"], async () => {
      events.push("first:start");
      await firstBlocked;
      events.push("first:end");
    });
    await Bun.sleep(0);

    const second = withPlaywrightInstanceMaintenance(["profile:b"], async () => {
      events.push("second:start");
    });
    await Bun.sleep(10);
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });
});

describe("withPlaywrightProfileMaintenance", () => {
  it("passes the canonical binding and a stop control under one barrier", async () => {
    const result = await withPlaywrightProfileMaintenance(
      "alice",
      "default",
      async (binding, { stopInstance }) => ({
        binding,
        stopped: await stopInstance(binding.instanceKey),
      }),
    );

    expect(result).toEqual({
      binding: {
        instanceKey: "profile:alice:default",
        ownerId: "alice",
        profile: "default",
      },
      stopped: false,
    });
  });
});

describe("selectOrphanBrowserPids", () => {
  const root = "/profiles";

  it("reaps processes under the profile root whose dir has no live instance", () => {
    const procs = [
      { pid: 100, userDataDir: "/profiles/research" }, // live → keep
      { pid: 200, userDataDir: "/profiles/dm" }, // orphan → reap
      { pid: 300, userDataDir: null }, // renderer (no dir) → skip
    ];
    expect(selectOrphanBrowserPids(procs, ["/profiles/research"], root, 1)).toEqual([200]);
  });

  it("never touches Chrome outside the profile root", () => {
    const procs = [
      { pid: 400, userDataDir: "/Users/me/Library/Chrome" },
      { pid: 401, userDataDir: "/profiles-lookalike/Chrome" },
    ];
    expect(selectOrphanBrowserPids(procs, [], root, 1)).toEqual([]);
  });

  it("skips its own pid and normalizes paths before comparing", () => {
    const procs = [
      { pid: 1, userDataDir: "/profiles/dm" }, // self → skip
      { pid: 500, userDataDir: "/profiles/./research" }, // == live after resolve → keep
    ];
    expect(selectOrphanBrowserPids(procs, ["/profiles/research"], root, 1)).toEqual([]);
  });
});

describe("selectIdleEvictionKey", () => {
  it("does not evict pinned instances or instances with lifecycle work in progress", () => {
    const now = 10_000;
    const candidates: Array<[string, { lastUsedAt: number }]> = [
      ["busy", { lastUsedAt: 0 }],
      ["pinned", { lastUsedAt: 100 }],
      ["available", { lastUsedAt: 200 }],
    ];

    expect(selectIdleEvictionKey(candidates, ["pinned"], ["busy"], now, 1000)).toBe("available");
  });
});

describe("selectReusablePort", () => {
  it("does not reuse an evicted port while the old process still owns it", () => {
    expect(selectReusablePort(9000, 9002, new Set([9001]), (port) => port === 9000)).toBe(9002);
  });
});

describe("browserProcessMatchesExpectedProfile", () => {
  it("requires an exact user-data-dir before killing a stale browser process", () => {
    expect(
      browserProcessMatchesExpectedProfile(
        "browser-rs --port 9000 --user-data-dir /profiles/alice",
        "/profiles/alice",
      ),
    ).toBe(true);
    expect(browserProcessMatchesExpectedProfile("browser-rs --port 9000", "/profiles/alice")).toBe(
      false,
    );
    expect(
      browserProcessMatchesExpectedProfile(
        "browser-rs --port 9000 --user-data-dir /profiles/bob",
        "/profiles/alice",
      ),
    ).toBe(false);
  });
});

describe("waitForChildProcessExit", () => {
  it("does not treat killed=true as process termination", async () => {
    const emitter = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      killed: boolean;
    };
    emitter.exitCode = null;
    emitter.signalCode = null;
    emitter.killed = true;
    let resolved = false;

    const waiting = waitForChildProcessExit(emitter as unknown as ChildProcess, 100).then(
      (result) => {
        resolved = true;
        return result;
      },
    );
    await Bun.sleep(5);
    expect(resolved).toBe(false);

    emitter.signalCode = "SIGTERM";
    emitter.emit("exit", null, "SIGTERM");
    expect(await waiting).toBe(true);
  });
});

describe("waitForChildProcessSpawnError", () => {
  it("preserves the original launcher error without waiting for health polling", async () => {
    const emitter = new EventEmitter();
    const waiting = waitForChildProcessSpawnError(emitter as unknown as ChildProcess);
    const error = Object.assign(new Error("spawn xvfb-run ENOENT"), { code: "ENOENT" });

    emitter.emit("error", error);

    await expect(waiting).rejects.toBe(error);
  });
});

describe("watchChildStartup", () => {
  it("fails immediately on early exit and preserves bounded stderr diagnostics", async () => {
    const emitter = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    emitter.exitCode = null;
    emitter.signalCode = null;
    const startup = watchChildStartup(
      emitter as unknown as ChildProcess,
      () => "Error: listen EADDRINUSE 127.0.0.1:9101",
    );

    emitter.exitCode = 1;
    emitter.emit("exit", 1, null);

    await expect(startup.failure).rejects.toThrow("EADDRINUSE");
    startup.stop();
  });

  it("rejects a child that exits after readiness but before port publication", () => {
    const processHandle = {
      exitCode: null,
      signalCode: null,
      killed: false,
    } as unknown as ChildProcess;
    const current = { process: processHandle };
    expect(isLiveOwnedChildProcess(current, processHandle)).toBe(true);

    Object.assign(processHandle, { exitCode: 1 });
    expect(isLiveOwnedChildProcess(current, processHandle)).toBe(false);
    expect(isLiveOwnedChildProcess(undefined, processHandle)).toBe(false);
  });
});
