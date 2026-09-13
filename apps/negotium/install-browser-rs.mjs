#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { resolve } from "node:path";

const VERSION = "v0.4.4";
const RELEASE_BASE = `https://github.com/maestrojeong/browser-rs-mcp/releases/download/${VERSION}`;
const TARGETS = {
  "darwin-arm64": {
    asset: "browser-rs-macos-arm64",
    sha256: "5b0ed73acf54caca6be2248d6cf45f44da0652d575a7f60f5a4fde61a9d8d2e1",
  },
  "linux-x64": {
    asset: "browser-rs-linux-x64",
    sha256: "d8936e9f84b666dc8df85a34acc5b182b0cdb30a9577c60af77ab3c3aac548c0",
  },
  "win32-x64": {
    asset: "browser-rs-windows-x64.exe",
    sha256: "413806e12ae2a9190410c95baa0c873dd849f251351b43b9e4fd13d65d637443",
  },
};

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function install() {
  if (process.env.NEGOTIUM_SKIP_BROWSER_RS_INSTALL === "1") return;
  const target = TARGETS[`${platform()}-${arch()}`];
  if (!target) {
    console.warn(
      `negotium: Browser.rs ${VERSION} has no binary for ${platform()}-${arch()}; browser tools will be unavailable`,
    );
    return;
  }

  const stateDir = process.env.NEGOTIUM_STATE_DIR?.trim()
    ? resolve(process.env.NEGOTIUM_STATE_DIR.trim())
    : resolve(homedir(), ".negotium");
  const installDir = resolve(stateDir, "binaries", "browser-rs", VERSION);
  // Windows decides executability by extension, so the binary has to land as
  // `browser-rs.exe` — `resolveBrowserRsBin` looks for exactly that name.
  const destination = resolve(installDir, `browser-rs${platform() === "win32" ? ".exe" : ""}`);
  await mkdir(installDir, { recursive: true });

  try {
    if (digest(await readFile(destination)) === target.sha256) {
      await chmod(destination, 0o755);
      return;
    }
  } catch {
    // Missing or invalid existing binary: download a verified replacement.
  }

  const response = await fetch(`${RELEASE_BASE}/${target.asset}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  const binary = Buffer.from(await response.arrayBuffer());
  const actual = digest(binary);
  if (actual !== target.sha256) {
    throw new Error(`checksum mismatch: expected ${target.sha256}, got ${actual}`);
  }

  const temporary = resolve(installDir, `.browser-rs-${process.pid}.tmp`);
  try {
    await writeFile(temporary, binary, { mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  console.log(`negotium: installed Browser.rs ${VERSION}`);
}

install().catch((error) => {
  console.warn(
    `negotium: Browser.rs install unavailable (${error instanceof Error ? error.message : String(error)}); browser tools will be unavailable`,
  );
  process.exitCode = 0;
});
