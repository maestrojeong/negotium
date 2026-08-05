#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { resolve } from "node:path";

const VERSION = "v0.1.3";
const RELEASE_BASE = `https://github.com/maestrojeong/bash-rs-mcp/releases/download/${VERSION}`;
const TARGETS = {
  "darwin-arm64": {
    asset: "bash-rs-macos-arm64",
    sha256: "3cb3b69b1e98bbe3536fe598ea4d214bab111833a434bdcac2c70c14c395ff1b",
  },
  "linux-x64": {
    asset: "bash-rs-linux-x64",
    sha256: "594f267c4a4b9ba907f25698c3edafc0ac1178c192df12af5efcc7eabd5f51a2",
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
      `negotium: bash-rs ${VERSION} has no binary for ${platform()}-${arch()}; background_bash falls back to the TS server`,
    );
    return;
  }

  const stateDir = process.env.NEGOTIUM_STATE_DIR?.trim()
    ? resolve(process.env.NEGOTIUM_STATE_DIR.trim())
    : resolve(homedir(), ".negotium");
  const installDir = resolve(stateDir, "binaries", "bash-rs", VERSION);
  const destination = resolve(installDir, "bash-rs");
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
    `negotium: bash-rs install unavailable (${error instanceof Error ? error.message : String(error)}); background_bash falls back to the TS server`,
  );
  process.exitCode = 0;
});
