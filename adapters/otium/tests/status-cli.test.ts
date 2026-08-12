import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import {
  attachedOtiumCells,
  configureOtiumCentral,
  isOtiumCentralConfigured,
  resetPeerCentralCaches,
} from "@/central";
import { joinFilePath, saveJoin } from "@/join";
import { statusCommand } from "@/status-cli";

function captureConsole(): { logs: string[]; warns: string[]; restore: () => void } {
  const logs: string[] = [];
  const warns: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  console.warn = (...args: unknown[]) => {
    warns.push(args.join(" "));
  };
  return {
    logs,
    warns,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
    },
  };
}

// Bun's `process.exitCode = undefined` is a no-op — it leaves whatever value
// was last assigned in place instead of clearing it — so every hook resets to
// `0` explicitly rather than `undefined`.
beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  if (existsSync(joinFilePath())) unlinkSync(joinFilePath());
  delete process.env.OTIUM_CENTRAL_URL;
  delete process.env.OTIUM_CELL_ID;
  delete process.env.OTIUM_CELL_SECRET;
  delete process.env.OTIUM_RELAY_URL;
  configureOtiumCentral(null);
  resetPeerCentralCaches();
  process.exitCode = 0;
});

describe("statusCommand", () => {
  test("reports not joined and exits non-zero when there is no join file", async () => {
    const capture = captureConsole();
    try {
      await statusCommand();
    } finally {
      capture.restore();
    }
    expect(capture.logs.join("\n")).toContain("not joined to any Otium workspace");
    expect(process.exitCode).toBe(1);
  });

  test("clears any pre-attached central cell state even on the not-joined path", async () => {
    // configureOtiumCentral is a process-wide singleton also touched by other
    // adapter code; the not-joined early return must not skip its cleanup.
    configureOtiumCentral({
      central: "http://127.0.0.1:4600",
      cellId: "cell_stale",
      secret: "rcs_stale",
    });
    expect(isOtiumCentralConfigured()).toBe(true);
    const capture = captureConsole();
    try {
      await statusCommand();
    } finally {
      capture.restore();
    }
    expect(isOtiumCentralConfigured()).toBe(false);
    expect(attachedOtiumCells()).toEqual([]);
  });

  test("prints cellId, central, and the node name resolved from central", async () => {
    saveJoin({ central: "http://127.0.0.1:4600", cellId: "cell_a", secret: "rcs_a" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        ok: true,
        workspaceId: "ws-1",
        nodes: [
          {
            cellId: "cell_a",
            nodeName: "nova",
            isPrimary: true,
            baseUrl: "http://127.0.0.1:4600",
            self: true,
          },
        ],
      })) as typeof fetch;
    const capture = captureConsole();
    try {
      await statusCommand();
    } finally {
      capture.restore();
      globalThis.fetch = realFetch;
    }
    const output = capture.logs.join("\n");
    expect(output).toContain("cellId:  cell_a");
    expect(output).toContain("central: http://127.0.0.1:4600");
    expect(output).toContain("node:    nova (primary)");
    expect(output).toContain("baseUrl: http://127.0.0.1:4600");
    expect(process.exitCode).toBe(0);
  });

  test("falls back to locally known info and warns when central is unreachable", async () => {
    saveJoin({ central: "http://127.0.0.1:1", cellId: "cell_b", secret: "rcs_b" });
    const capture = captureConsole();
    try {
      await statusCommand();
    } finally {
      capture.restore();
    }
    const output = capture.logs.join("\n");
    expect(output).toContain("cellId:  cell_b");
    expect(output).toContain("central: http://127.0.0.1:1");
    expect(capture.warns.join("\n")).toContain("could not verify against central");
  });

  test("lists every joined workspace when there is more than one", async () => {
    saveJoin({ central: "http://127.0.0.1:4600", cellId: "cell_a", secret: "rcs_a" });
    saveJoin({ central: "http://127.0.0.1:4601", cellId: "cell_c", secret: "rcs_c" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ ok: true, workspaceId: "ws-x", nodes: [] })) as typeof fetch;
    const capture = captureConsole();
    try {
      await statusCommand();
    } finally {
      capture.restore();
      globalThis.fetch = realFetch;
    }
    const output = capture.logs.join("\n");
    expect(output).toContain("cell_a");
    expect(output).toContain("cell_c");
  });
});
