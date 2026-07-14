import { spawn } from "node:child_process";
import { logger } from "#platform/logger";
import { redactVaultSecrets, vaultSubstituteDetailed } from "#storage/vault";

export interface VaultRunRequest {
  command: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
}

export interface VaultRunResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  usedKeys: string[];
  error?: string;
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
  maxBytes: number,
): void {
  if (state.bytes >= maxBytes) {
    state.truncated = true;
    return;
  }
  const remaining = maxBytes - state.bytes;
  const visible = chunk.subarray(0, remaining);
  chunks.push(visible);
  state.bytes += visible.byteLength;
  if (visible.byteLength < chunk.byteLength) state.truncated = true;
}

/** Execute a placeholder-bearing shell command without exposing expanded input/output to the SDK. */
export async function executeVaultRun(
  userId: string,
  request: VaultRunRequest,
): Promise<VaultRunResult> {
  const substitution = vaultSubstituteDetailed(userId, request.command);
  if (substitution.usedKeys.length === 0) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      truncated: false,
      usedKeys: [],
      error: "No valid Vault placeholder was found in command",
    };
  }

  const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 120_000, 1_000), 600_000);
  const maxOutputBytes = Math.min(
    Math.max(request.maxOutputBytes ?? 512 * 1024, 1_024),
    2 * 1024 * 1024,
  );
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutState = { bytes: 0, truncated: false };
  const stderrState = { bytes: 0, truncated: false };
  const startedAt = Date.now();

  return await new Promise<VaultRunResult>((resolve) => {
    // Feed the expanded script over stdin so plaintext never appears in argv or
    // the provider-visible tool input. zsh -s reads commands from standard input.
    const child = spawn(process.env.SHELL || "/bin/sh", ["-s"], {
      cwd: request.cwd,
      detached: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let timedOut = false;
    const signalTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The process tree already exited.
        }
      }
    };

    const finish = (result: Omit<VaultRunResult, "usedKeys">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      logger.info(
        {
          userId,
          vaultKeys: substitution.usedKeys,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: Date.now() - startedAt,
          timedOut,
        },
        "vault credential command used",
      );
      resolve({ ...result, usedKeys: substitution.usedKeys });
    };

    child.stdout.on("data", (chunk: Buffer) =>
      appendBounded(stdoutChunks, chunk, stdoutState, maxOutputBytes),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      appendBounded(stderrChunks, chunk, stderrState, maxOutputBytes),
    );
    child.once("error", (error) => {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        truncated: false,
        error: redactVaultSecrets(userId, error.message),
      });
    });
    child.once("close", (exitCode, signal) => {
      // vault_run is deliberately foreground-only. Clean up descendants a
      // command attempted to leave behind so secrets do not linger in argv/env.
      signalTree("SIGTERM");
      const stdout = redactVaultSecrets(userId, Buffer.concat(stdoutChunks).toString("utf8"));
      const stderr = redactVaultSecrets(userId, Buffer.concat(stderrChunks).toString("utf8"));
      finish({
        ok: !timedOut && exitCode === 0,
        exitCode,
        signal,
        stdout,
        stderr,
        truncated: stdoutState.truncated || stderrState.truncated,
        ...(timedOut ? { error: `Command timed out after ${timeoutMs}ms` } : {}),
      });
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      signalTree("SIGKILL");
    }, timeoutMs);

    child.stdin.end(substitution.text);
  });
}
