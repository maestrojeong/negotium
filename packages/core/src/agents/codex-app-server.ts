import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { codexCliScriptPath } from "#agents/codex-native-multi-agent";
import { hostedCodexHomePath } from "#agents/execution-host";
import { latestCodexRolloutPath } from "#agents/rollout/codex";
import { NEGOTIUM_VERSION } from "#version";

interface CodexAppServerForkResult {
  forkId: string;
  rolloutPath: string;
}

interface CodexAppServerForkHost {
  spawnServer(): ChildProcessWithoutNullStreams;
  findRolloutPath(threadId: string): string | undefined;
  timeoutMs: number;
}

type JsonRpcResponse = {
  id?: number;
  result?: { thread?: { id?: unknown } };
  error?: { message?: unknown };
};

export function createCodexAppServerForker(host: CodexAppServerForkHost) {
  return async (parentThreadId: string): Promise<CodexAppServerForkResult> => {
    const child = host.spawnServer();

    return await new Promise<CodexAppServerForkResult>((resolve, reject) => {
      let settled = false;
      let stdoutBuffer = "";
      let stderr = "";
      const timer = setTimeout(
        () => finish(new Error("Codex thread fork timed out")),
        host.timeoutMs,
      );

      const finish = (error?: Error, result?: CodexAppServerForkResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.stdin.end();
          child.kill();
        } catch {
          // The app server may already have exited after stdin closed.
        }
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error("Codex thread fork returned no result"));
      };

      const send = (message: Record<string, unknown>) => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };

      child.stderr.on("data", (chunk) => {
        if (stderr.length < 8_192) stderr += String(chunk);
      });
      child.on("error", (error) => finish(error));
      child.on("exit", (code, signal) => {
        if (settled) return;
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        finish(
          new Error(
            `Codex app server exited with ${detail}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      });
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
        for (;;) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          let message: JsonRpcResponse;
          try {
            message = JSON.parse(line) as JsonRpcResponse;
          } catch {
            continue;
          }

          if (message.id === 1) {
            if (message.error) {
              finish(new Error(String(message.error.message || "Codex initialization failed")));
              return;
            }
            send({ method: "initialized" });
            send({ id: 2, method: "thread/fork", params: { threadId: parentThreadId } });
            continue;
          }
          if (message.id !== 2) continue;
          if (message.error) {
            finish(new Error(String(message.error.message || "Codex thread fork failed")));
            return;
          }
          const forkId = message.result?.thread?.id;
          if (typeof forkId !== "string" || !forkId) {
            finish(new Error("Codex thread fork returned no thread id"));
            return;
          }
          const rolloutPath = host.findRolloutPath(forkId);
          if (!rolloutPath) {
            finish(new Error(`Codex thread fork rollout was not found for ${forkId}`));
            return;
          }
          finish(undefined, { forkId, rolloutPath });
          return;
        }
      });

      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "negotium", version: NEGOTIUM_VERSION },
        },
      });
    });
  };
}

const forkCodexThread = createCodexAppServerForker({
  spawnServer() {
    return spawn(process.execPath, [codexCliScriptPath(), "app-server", "--stdio"], {
      env: { ...process.env, CODEX_HOME: hostedCodexHomePath() },
      stdio: ["pipe", "pipe", "pipe"],
    });
  },
  findRolloutPath: latestCodexRolloutPath,
  timeoutMs: 15_000,
});

export async function forkCodexSession(parentThreadId: string): Promise<CodexAppServerForkResult> {
  return await forkCodexThread(parentThreadId);
}
