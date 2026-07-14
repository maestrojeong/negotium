import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { WORKSPACE_DIR } from "@negotium/core";

export const CRON_JOBS_DIR = resolve(
  process.env.NEGOTIUM_CRON_JOBS_DIR?.trim() || resolve(WORKSPACE_DIR, "cron", "jobs"),
);

const DEFAULT_SCRIPT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2_500;

export class CronScriptError extends Error {
  constructor(
    message: string,
    readonly kind: "error" | "timeout" | "output-limit" = "error",
  ) {
    super(message);
    this.name = "CronScriptError";
  }
}

export function validateCronScriptName(
  script: string,
): { ok: true } | { ok: false; error: string } {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.py$/.test(script) ||
    script.includes("..") ||
    script.includes("/") ||
    script.includes("\\")
  ) {
    return { ok: false, error: `script must be a plain .py filename under ${CRON_JOBS_DIR}` };
  }
  return { ok: true };
}

export function resolveCronScriptPath(script: string): string {
  const valid = validateCronScriptName(script);
  if (!valid.ok) throw new Error(valid.error);
  const path = resolve(CRON_JOBS_DIR, script);
  if (!path.startsWith(`${CRON_JOBS_DIR}${sep}`))
    throw new Error("script path escaped jobs directory");
  return path;
}

export function listCronScripts(): string[] {
  mkdirSync(CRON_JOBS_DIR, { recursive: true });
  return readdirSync(CRON_JOBS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && validateCronScriptName(entry.name).ok)
    .map((entry) => entry.name)
    .sort();
}

export function cronScriptExists(script: string): boolean {
  try {
    return existsSync(resolveCronScriptPath(script));
  } catch {
    return false;
  }
}

function commandForScript(scriptPath: string): { executable: string; args: string[] } {
  const configured = process.env.NEGOTIUM_CRON_PYTHON?.trim();
  if (configured) return { executable: configured, args: [scriptPath] };
  if (Bun.which("uv")) {
    return {
      executable: "uv",
      args: ["run", "--project", CRON_JOBS_DIR, "python", scriptPath],
    };
  }
  return { executable: "python3", args: [scriptPath] };
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

export async function runCronPromptScript(options: {
  script: string;
  cwd: string;
  jobId: string;
  topicId: string;
  timeoutMs?: number;
  outputLimitBytes?: number;
  signal?: AbortSignal;
}): Promise<string> {
  if (options.signal?.aborted) throw new CronScriptError("script run aborted");
  const scriptPath = resolveCronScriptPath(options.script);
  if (!existsSync(scriptPath))
    throw new CronScriptError(`cron script not found: ${options.script}`);
  const timeoutMs = Math.max(5_000, options.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS);
  const outputLimitBytes = Math.max(1024, options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES);
  const command = commandForScript(scriptPath);
  let child: ChildProcess;
  try {
    child = spawn(command.executable, command.args, {
      cwd: options.cwd,
      detached: true,
      env: {
        ...process.env,
        NEGOTIUM_CRON_JOB_ID: options.jobId,
        NEGOTIUM_CRON_TOPIC_ID: options.topicId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new CronScriptError(
      `script spawn failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!child.stdout || !child.stderr) {
    signalTree(child, "SIGKILL");
    throw new CronScriptError("script spawn failed: stdout/stderr pipes unavailable");
  }

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let failure: CronScriptError | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (error: CronScriptError) => {
    if (failure) return;
    failure = error;
    signalTree(child, "SIGTERM");
    killTimer = setTimeout(() => signalTree(child, "SIGKILL"), KILL_GRACE_MS);
    killTimer.unref?.();
  };
  const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputBytes += buffer.length;
    if (outputBytes > outputLimitBytes) {
      terminate(
        new CronScriptError(`script output exceeded ${outputLimitBytes} bytes`, "output-limit"),
      );
      return;
    }
    target.push(buffer);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));

  const timeout = setTimeout(
    () => terminate(new CronScriptError(`script exceeded ${timeoutMs}ms`, "timeout")),
    timeoutMs,
  );
  timeout.unref?.();
  const onAbort = () => terminate(new CronScriptError("script run aborted"));
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    },
  ).finally(() => {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", onAbort);
  });

  if (failure) throw failure;
  if (result.code !== 0) {
    const detail = result.signal ? `signal ${result.signal}` : `code ${result.code ?? "unknown"}`;
    const errorText = Buffer.concat(stderr).toString("utf8").trim();
    throw new CronScriptError(
      `script exited with ${detail}${errorText ? `: ${errorText.slice(0, 2_000)}` : ""}`,
    );
  }
  return Buffer.concat(stdout).toString("utf8").trim();
}
