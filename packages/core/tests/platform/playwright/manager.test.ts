import { describe, expect, it } from "bun:test";
import {
  extractUserDataDirArg,
  makeInstanceKey,
  selectOrphanBrowserPids,
} from "#platform/playwright/manager";

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
  it("uses only the Otium topic/profile identity", () => {
    expect(makeInstanceKey("alice", "topic-123")).toBe("topic:topic-123");
    expect(makeInstanceKey("bob", "topic-123")).toBe("topic:topic-123");
  });

  it("falls back to the shared dm profile when no topic is provided", () => {
    expect(makeInstanceKey("alice", undefined)).toBe("dm");
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
