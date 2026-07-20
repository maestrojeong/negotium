import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

export interface HeadedPlaywrightSpawnSpec {
  command: string;
  args: string[];
  virtualDisplay: boolean;
}

interface HeadedPlaywrightSpawnOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  findExecutable?: (command: string, environment: NodeJS.ProcessEnv) => string | null;
}

function findExecutableOnPath(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates = isAbsolute(command)
    ? [command]
    : (environment.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

/** Select the safe argv-only launcher for a visible browser MCP. */
export function resolveHeadedPlaywrightSpawn(
  command: string,
  args: readonly string[],
  options: HeadedPlaywrightSpawnOptions = {},
): HeadedPlaywrightSpawnSpec {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const hasDisplay = Boolean(environment.DISPLAY?.trim() || environment.WAYLAND_DISPLAY?.trim());
  if (platform !== "linux" || hasDisplay) {
    return { command, args: [...args], virtualDisplay: false };
  }

  const xvfbRun = (options.findExecutable ?? findExecutableOnPath)("xvfb-run", environment);
  if (!xvfbRun) {
    throw new Error(
      "Headed Playwright on Linux requires DISPLAY/WAYLAND_DISPLAY or xvfb-run; install Xvfb and ensure xvfb-run is on PATH",
    );
  }
  return {
    command: xvfbRun,
    args: ["-a", "-s", "-screen 0 1440x1000x24", command, ...args],
    virtualDisplay: true,
  };
}
