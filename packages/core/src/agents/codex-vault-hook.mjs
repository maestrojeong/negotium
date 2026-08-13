import { createConnection } from "node:net";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const [socketPathArg, tokenArg] = process.argv.slice(2);
const socketPath = socketPathArg || process.env.NEGOTIUM_CODEX_VAULT_HOOK_SOCKET;
const token = tokenArg || process.env.NEGOTIUM_CODEX_VAULT_HOOK_TOKEN;

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

async function requestBridge(input) {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let response = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
        socket.destroy(new Error("Vault hook response exceeded the size limit"));
      }
    });
    socket.on("end", () => resolve(JSON.parse(response)));
    socket.write(`${JSON.stringify({ token, input })}\n`);
  });
}

try {
  if (!socketPath || !token) throw new Error("Vault hook capability is unavailable");
  const result = await requestBridge(await readStdin());
  if (!result?.ok) throw new Error(result?.error || "Vault hook bridge rejected the request");
  process.stdout.write(JSON.stringify(result.output ?? {}));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify(deny(`Vault substitution unavailable: ${message}`)));
}
