import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  browserProcessMatchesExpectedProfile,
  extractUserDataDirArg,
  isBrowserJanitorOwner,
  makeInstanceKey,
  selectIdleEvictionKey,
  selectOrphanBrowserPids,
  selectReusablePort,
  waitForChildProcessExit,
  waitForChildProcessSpawnError,
  withPlaywrightInstanceMaintenance,
} from "#platform/playwright/manager";

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

describe("withPlaywrightInstanceMaintenance", () => {
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
    const procs = [{ pid: 400, userDataDir: "/Users/me/Library/Chrome" }];
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
        "node mcp-patchright --port 9000 --user-data-dir /profiles/alice",
        "/profiles/alice",
      ),
    ).toBe(true);
    expect(
      browserProcessMatchesExpectedProfile("node mcp-patchright --port 9000", "/profiles/alice"),
    ).toBe(false);
    expect(
      browserProcessMatchesExpectedProfile(
        "node mcp-patchright --port 9000 --user-data-dir /profiles/bob",
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
