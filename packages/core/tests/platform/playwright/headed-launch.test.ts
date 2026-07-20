import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveHeadedPlaywrightSpawn } from "#platform/playwright/headed-launch";

describe("resolveHeadedPlaywrightSpawn", () => {
  const command = "/usr/bin/node";
  const args = ["/app/mcp.mjs", "--headed"];

  it("keeps the direct spawn on macOS", () => {
    expect(
      resolveHeadedPlaywrightSpawn(command, args, {
        platform: "darwin",
        environment: {},
      }),
    ).toEqual({ command, args, virtualDisplay: false });
  });

  it("keeps the direct spawn on Linux when DISPLAY already exists", () => {
    expect(
      resolveHeadedPlaywrightSpawn(command, args, {
        platform: "linux",
        environment: { DISPLAY: ":7" },
      }),
    ).toEqual({ command, args, virtualDisplay: false });
  });

  it("keeps the direct spawn on Linux when only WAYLAND_DISPLAY exists", () => {
    expect(
      resolveHeadedPlaywrightSpawn(command, args, {
        platform: "linux",
        environment: { DISPLAY: "  ", WAYLAND_DISPLAY: "wayland-0" },
      }),
    ).toEqual({ command, args, virtualDisplay: false });
  });

  it("keeps the direct spawn on non-Linux platforms", () => {
    expect(
      resolveHeadedPlaywrightSpawn(command, args, {
        platform: "win32",
        environment: {},
      }),
    ).toEqual({ command, args, virtualDisplay: false });
  });

  it("wraps Linux headed execution in xvfb-run when no display exists", () => {
    expect(
      resolveHeadedPlaywrightSpawn(command, args, {
        platform: "linux",
        environment: { PATH: "/usr/bin" },
        findExecutable: () => "/usr/bin/xvfb-run",
      }),
    ).toEqual({
      command: "/usr/bin/xvfb-run",
      args: ["-a", "-s", "-screen 0 1440x1000x24", command, ...args],
      virtualDisplay: true,
    });
  });

  it("fails fast on Linux without a display or xvfb-run", () => {
    expect(() =>
      resolveHeadedPlaywrightSpawn(command, args, {
        platform: "linux",
        environment: { PATH: "/missing" },
        findExecutable: () => null,
      }),
    ).toThrow("requires DISPLAY/WAYLAND_DISPLAY or xvfb-run");
  });

  it("searches PATH for an executable xvfb-run and skips non-executable candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "negotium-xvfb-path-"));
    const blockedDir = join(root, "blocked");
    const executableDir = join(root, "executable");
    mkdirSync(blockedDir);
    mkdirSync(executableDir);
    const blocked = join(blockedDir, "xvfb-run");
    const executable = join(executableDir, "xvfb-run");
    writeFileSync(blocked, "#!/bin/sh\n");
    writeFileSync(executable, "#!/bin/sh\n");
    chmodSync(blocked, 0o644);
    chmodSync(executable, 0o755);

    try {
      expect(
        resolveHeadedPlaywrightSpawn(command, args, {
          platform: "linux",
          environment: {
            DISPLAY: " ",
            WAYLAND_DISPLAY: "\t",
            PATH: [blockedDir, executableDir].join(delimiter),
          },
        }),
      ).toEqual({
        command: executable,
        args: ["-a", "-s", "-screen 0 1440x1000x24", command, ...args],
        virtualDisplay: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
