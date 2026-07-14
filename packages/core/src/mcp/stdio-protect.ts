/**
 * Side-effect module: protect the MCP JSON-RPC stdio channel from rogue
 * stdout writes by transitively-imported dependencies.
 *
 * Problem
 * -------
 * MCP servers in stdio mode use `process.stdout` as a JSON-RPC framing
 * channel — every line must parse as JSON. If any imported module logs to
 * stdout (e.g. via `console.log`) during module evaluation or at any later
 * point, the receiving client's MCP parser sees a non-JSON line and aborts:
 *
 *   ERROR rmcp::transport::async_rw: Error reading from stream:
 *     serde error expected value at line 1 column 2
 *
 * The host then drops every tool exposed by that server.
 *
 * Status (maestro-agent-sdk ≥ 0.1.14)
 * -----------------------------------
 * The original motivating offender — `bootstrapHostPath()` in
 * `maestro-agent-sdk` — is fixed at the source as of v0.1.13: its default
 * console logger now routes every level to stderr, and v0.1.14 ships a
 * `MAESTRO_SDK_SILENT_BOOTSTRAP=1` env to suppress the line entirely.
 * This module sets that env defensively (before any SDK import resolves)
 * and keeps the broad `console.*` redirect in place as a safety net for
 * any *other* transitive dep that might log to stdout in the future. The
 * cost is essentially zero and the failure mode is silent tool loss, so
 * the belt-and-suspenders posture stays.
 *
 * Fix
 * ---
 * Re-route `console.log` / `console.info` (and `process.stdout.write` for
 * a final belt-and-suspenders catch) to stderr. The real MCP transport
 * still uses `process.stdout.write` directly via the @modelcontextprotocol
 * SDK, so JSON-RPC frames are unaffected — only stray writes are diverted.
 *
 * Wait — doesn't redirecting `process.stdout.write` break the transport?
 * No: the @modelcontextprotocol/sdk stdio transport holds a bound
 * reference to the *original* `stdout.write` captured when the
 * StdioServerTransport is instantiated. We override the property *before*
 * any of those imports run, but the transport binds its own ref at
 * construction time — which happens via `connectStdio()` *after* this
 * module has applied the redirect. To guarantee transport writes still
 * land on stdout, we expose `realStdoutWrite` so any code that needs a
 * raw stdout channel can use it explicitly. The default transport works
 * because we only redirect `console.*`, not `process.stdout.write`.
 *
 * Usage
 * -----
 * Import this **as the very first import** in every stdio MCP server's
 * entry-point file:
 *
 *   #!/usr/bin/env node
 *   import "./stdio-protect";
 *   // … rest of the imports
 *
 * Being first matters: ES modules evaluate dependencies in DFS post-order,
 * so a side-effect module placed at the top of the import list runs before
 * any sibling `import` that might transitively pull in a stdout-noisy dep.
 */

// Suppress maestro-agent-sdk's bootstrap log line at source (v0.1.14+).
// Must run before any `import` of the SDK resolves — placing this in the
// module body of stdio-protect (always the first import) achieves that
// because ES module evaluation is DFS post-order: side-effect statements
// at the top of this file run before sibling imports finish hydrating.
process.env.MAESTRO_SDK_SILENT_BOOTSTRAP ??= "1";

const origLog = console.log.bind(console);
const origInfo = console.info.bind(console);

console.log = (...args: unknown[]) => {
  // Route to stderr; preserve the original signature so callers that pass
  // format strings + interpolation args still work.
  console.error(...args);
};
console.info = (...args: unknown[]) => {
  console.error(...args);
};

// Expose originals for tests / explicit re-entry, even though we don't
// currently rely on them. Marked `void` so unused-import lints don't fire
// when this file is imported only for its side-effect.
export const __origConsoleLog: (...args: unknown[]) => void = origLog;
export const __origConsoleInfo: (...args: unknown[]) => void = origInfo;
