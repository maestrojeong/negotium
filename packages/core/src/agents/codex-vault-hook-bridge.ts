import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexCliScriptPath } from "#agents/codex-native-multi-agent";
import { deepMapStrings } from "#agents/deep-map";
import { referencesHostedSecretStorage, substituteHostedSecrets } from "#agents/execution-host";
import { shouldSubstituteVaultToolInput } from "#agents/vault-tool-policy";

const MAX_HOOK_REQUEST_BYTES = 1024 * 1024;
const SENSITIVE_STORAGE_DENIAL = "Runtime secret storage access is not permitted";
const HOOK_SOCKET_ENV = "NEGOTIUM_CODEX_VAULT_HOOK_SOCKET";
const HOOK_TOKEN_ENV = "NEGOTIUM_CODEX_VAULT_HOOK_TOKEN";

export interface CodexPreToolUseInput {
  hook_event_name?: string;
  tool_name: string;
  tool_input: unknown;
}

export type CodexPreToolUseOutput = Record<string, unknown>;

export interface CodexVaultHookOperations {
  referencesSensitiveStorage(value: unknown): boolean;
  substitute(userId: string, value: string): string;
}

export function evaluateCodexVaultPreToolUse(
  input: CodexPreToolUseInput,
  userId: string,
  operations: CodexVaultHookOperations,
): CodexPreToolUseOutput {
  if (operations.referencesSensitiveStorage(input.tool_input)) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: SENSITIVE_STORAGE_DENIAL,
      },
    };
  }

  if (!shouldSubstituteVaultToolInput(input.tool_name)) return {};
  const updatedInput = deepMapStrings(input.tool_input, (value) =>
    operations.substitute(userId, value),
  );
  if (JSON.stringify(updatedInput) === JSON.stringify(input.tool_input)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function hookClientPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const adjacent = resolve(moduleDir, "codex-vault-hook.mjs");
  if (existsSync(adjacent)) return adjacent;
  const packaged = resolve(moduleDir, "runtime/src/agents/codex-vault-hook.mjs");
  if (existsSync(packaged)) return packaged;
  throw new Error("Codex Vault hook client is missing from this installation");
}

function privateCodexWrapper(codexScript: string, socketPath: string, token: string): string {
  return [
    "#!/bin/sh",
    `export ${HOOK_SOCKET_ENV}=${shellQuote(socketPath)}`,
    `export ${HOOK_TOKEN_ENV}=${shellQuote(token)}`,
    'if [ "$1" = "exec" ]; then',
    "  shift",
    `  exec ${shellQuote(process.execPath)} ${shellQuote(codexScript)} exec --dangerously-bypass-hook-trust "$@"`,
    "fi",
    `exec ${shellQuote(process.execPath)} ${shellQuote(codexScript)} "$@"`,
    "",
  ].join("\n");
}

export interface CodexVaultHookBridge {
  codexPathOverride: string;
  environment: Record<string, string>;
  hooks: {
    PreToolUse: Array<{
      matcher: string;
      hooks: Array<{
        type: string;
        command: string;
        timeout: number;
        statusMessage: string;
      }>;
    }>;
  };
  close(): Promise<void>;
}

export async function createCodexVaultHookBridge(userId: string): Promise<CodexVaultHookBridge> {
  const root = await mkdtemp(join(tmpdir(), "negotium-codex-vault-"));
  await chmod(root, 0o700);
  const socketPath = join(root, "hook.sock");
  const wrapperPath = join(root, "codex-with-hooks");
  const token = randomBytes(32).toString("hex");
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.setEncoding("utf8");
    let request = "";
    let handled = false;
    const handleRequest = () => {
      if (handled) return;
      handled = true;
      try {
        const parsed = JSON.parse(request.trimEnd()) as {
          token?: unknown;
          input?: CodexPreToolUseInput;
        };
        if (parsed.token !== token) throw new Error("invalid hook capability");
        if (
          !parsed.input ||
          typeof parsed.input !== "object" ||
          typeof parsed.input.tool_name !== "string"
        ) {
          throw new Error("invalid PreToolUse payload");
        }
        const output = evaluateCodexVaultPreToolUse(parsed.input, userId, {
          referencesSensitiveStorage: referencesHostedSecretStorage,
          substitute: substituteHostedSecrets,
        });
        socket.end(JSON.stringify({ ok: true, output }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        socket.end(JSON.stringify({ ok: false, error: message }));
      }
    };
    socket.on("data", (chunk: string) => {
      request += chunk;
      if (Buffer.byteLength(request) > MAX_HOOK_REQUEST_BYTES) socket.destroy();
      else if (request.endsWith("\n")) handleRequest();
    });
    socket.on("end", handleRequest);
  });

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolveListen();
      });
    });
    await chmod(socketPath, 0o600);
    await writeFile(wrapperPath, privateCodexWrapper(codexCliScriptPath(), socketPath, token), {
      mode: 0o700,
    });

    // Keep the capability out of the process list and reviewed hook command.
    // The private wrapper explicitly authorizes this runtime-owned hook for
    // headless Codex turns.
    const command = [shellQuote(process.execPath), shellQuote(hookClientPath())].join(" ");
    return {
      codexPathOverride: wrapperPath,
      environment: { [HOOK_SOCKET_ENV]: socketPath, [HOOK_TOKEN_ENV]: token },
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command,
                timeout: 30,
                statusMessage: "Resolving Vault placeholders",
              },
            ],
          },
        ],
      },
      async close() {
        for (const socket of connections) socket.destroy();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
