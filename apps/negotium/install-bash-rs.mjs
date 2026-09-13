#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { resolve } from "node:path";

const VERSION = "v0.1.10";
const RELEASE_BASE = `https://github.com/maestrojeong/bash-rs-mcp/releases/download/${VERSION}`;
const TARGETS = {
  "darwin-arm64": {
    asset: "bash-rs-macos-arm64",
    sha256: "7cb88480af5ec5ac9d3d82aebb83cf652e3c9d01f448a374d8c98c8b20459f37",
  },
  "linux-x64": {
    asset: "bash-rs-linux-x64",
    sha256: "3fb17619f15ea9ea3778c090fe1f2abea363c51a2b0750e4bd0bc72430adefe1",
  },
  // Linux on arm64 is what an Apple Silicon machine runs containers as, and
  // what the cheaper cloud instances are. Until v0.1.6 published this asset,
  // background_bash was simply absent on those hosts.
  "linux-arm64": {
    asset: "bash-rs-linux-arm64",
    sha256: "5f9a4e985c45b5af55c50427194d9680f875ddf2f95fc66ddb6cfff20f52af36",
  },
  "win32-x64": {
    asset: "bash-rs-windows-x64.exe",
    sha256: "233902374581fcec3d010664b520a1cb8ade15b73aef064ddf1bbdac34b26aa5",
  },
};

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function install() {
  if (process.env.NEGOTIUM_SKIP_BASH_RS_INSTALL === "1") return;
  const target = TARGETS[`${platform()}-${arch()}`];
  if (!target) {
    console.warn(
      `negotium: bash-rs ${VERSION} has no binary for ${platform()}-${arch()}; background_bash will be unavailable on this host`,
    );
    return;
  }

  const stateDir = process.env.NEGOTIUM_STATE_DIR?.trim()
    ? resolve(process.env.NEGOTIUM_STATE_DIR.trim())
    : resolve(homedir(), ".negotium");
  const installDir = resolve(stateDir, "binaries", "bash-rs", VERSION);
  // Windows decides executability by extension, so the binary has to land as
  // `bash-rs.exe` — `resolveBashRsBin` looks for exactly that name.
  const destination = resolve(installDir, `bash-rs${platform() === "win32" ? ".exe" : ""}`);
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

  const temporary = resolve(installDir, `.bash-rs-${process.pid}.tmp`);
  try {
    await writeFile(temporary, binary, { mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  console.log(`negotium: installed bash-rs ${VERSION}`);
}

install().catch((error) => {
  console.warn(
    `negotium: bash-rs install unavailable (${error instanceof Error ? error.message : String(error)}); background_bash will be unavailable on this host`,
  );
  process.exitCode = 0;
});
