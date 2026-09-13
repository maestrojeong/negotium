import { describe, expect, it } from "bun:test";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveHeadedPlaywrightSpawn } from "#platform/playwright/headed-launch";

/**
 * The PATH search below tells candidates apart by their execute bit, staged
 * with `chmod`. Windows has no execute bit — `chmod` does not clear X_OK there,
 * so both candidates look runnable and the case cannot express what it is
 * checking. Probe the host rather than naming a platform.
 */
const honoursExecuteBit = (() => {
  const probe = mkdtempSync(join(tmpdir(), "negotium-execbit-probe-"));
  try {
    const file = join(probe, "not-executable");
    writeFileSync(file, "");
    chmodSync(file, 0o644);
    accessSync(file, constants.X_OK);
    return false;
  } catch {
    return true;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

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

  it.skipIf(!honoursExecuteBit)(
    "searches PATH for an executable xvfb-run and skips non-executable candidates",
    () => {
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
    },
  );
});
