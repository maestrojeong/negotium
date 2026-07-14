import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Node state directory. Each machine is one negotium node; all node state
 * lives in one dotdir. `NEGOTIUM_STATE_DIR` overrides (tests,
 * multi-node-on-one-box). Resolved lazily at call time — not module load —
 * so tests can point the env var at a temp dir before constructing objects.
 */
export function stateDir(): string {
  const env = process.env.NEGOTIUM_STATE_DIR?.trim();
  return env ? resolve(env) : resolve(homedir(), ".negotium");
}

/** Default directory holding one port file per running http MCP instance. */
export function defaultPortsDir(): string {
  return resolve(stateDir(), "run", "mcp-ports");
}

/** Default location of the persistent per-node MCP manifest. */
export function defaultManifestFile(): string {
  return resolve(stateDir(), "data", "mcp-manifest.json");
}
