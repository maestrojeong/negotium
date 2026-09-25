#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { resolve } from "node:path";

const VERSION = "v0.7.0";
const RELEASE_BASE = `https://github.com/maestrojeong/browser-rs-mcp/releases/download/${VERSION}`;
const TARGETS = {
  "darwin-arm64": {
    asset: "browser-rs-macos-arm64",
    sha256: "623497479cbfd069b7ed7e3cf53607ba8cb1eea6ca81f5c2574aeb46d4e9a9f0",
  },
  "linux-x64": {
    asset: "browser-rs-linux-x64",
    sha256: "4b7fa9467ca75fafb5b551ba1b571f8414b52d391889cd713bdc1c834a3e27c0",
  },
  "win32-x64": {
    asset: "browser-rs-windows-x64.exe",
    sha256: "e178e281146fef35d626f300f3e91ddcf99aca9b533eb8676fa9299d0431487a",
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
