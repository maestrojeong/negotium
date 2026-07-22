/**
 * Maestro agent provider — thin local adapter over `maestro-agent-sdk`.
 *
 * Mirrors the pattern of claude-provider.ts / codex-provider.ts so that
 * agents/index.ts can import all three providers from sibling `@/agents/*`
 * paths rather than mixing package and local imports. The wrapper layer is
 * the natural extension point for Otium-specific overrides — anything
 * we want every maestro call to inherit gets stamped here before reaching
 * the SDK.
 *
 * v0.1.19 host overrides:
 *   - `enableBackgroundBash: false` — the SDK's Claude-Code-style triad
 *     (`Bash(run_in_background:true)` + `BashOutput` + `KillBash`) is OFF.
 *     It was briefly always-on, but in this headless setup a background
 *     bash's completion never triggers a new model turn — the process runs
 *     in the bot but nobody polls it once the turn ends. Topics use
 *     `mcp__background-bash__background_bash_run` instead, which injects a
 *     session-inbox tell entry on exit so the loop actually closes.
 *
 * v0.1.21 host overrides:
 *   - `maxTokens: 32_768` — global default for the per-API-call output
 *     ceiling. Pre-v0.1.21 the SDK silently fell back to 4096, which
 *     truncated long-form generation mid-string and broke Write/Edit
 *     tool input JSON for multi-K file bodies (see the v0.1.21
 *     changelog for the bug write-up). 32K is the Otium-wide
 *     default because:
 *       - long-form legal reports (슈퍼로이어, 기일보고) routinely
 *         exceed 4K and have been the load-bearing failure surface;
 *       - 32K is generous enough that ~99% of realistic single-turn
 *         outputs fit without truncation;
 *       - keeps cost / latency bounded relative to the SDK's own
 *         model-catalog defaults (deepseek-pro 64K, kimi-k3 64K,
 *         kimi-k2.7-code 32K)
 *         which can be expensive for accidental long outputs.
 *     Callers that need more (or less) override per-call via
 *     `AgentQueryOptions.maxTokens` — the caller-supplied value wins
 *     because `...opts` spreads AFTER the defaults below.
 *
 * v0.1.22 host overrides:
 *   - `enableToolSearch: true` — deferred-tool / ToolSearch pattern is ON.
 *     The pattern adds a round-trip every time a new tool is first reached
 *     for (turn N: model calls `ToolSearch` → turn N+1: model calls the
 *     actual tool), but that extra round-trip is now cheap relative to the
 *     reminder-token savings across Otium's MCP server count, so the
 *     tradeoff flipped in favor of deferral. Stamped as a literal `true`
 *     (not omitted) so a code-reader sees the decision instead of guessing
 *     intent. Caller-supplied `enableToolSearch: false` still wins because
 *     `...opts` spreads AFTER this default; a future dispatcher / topic
 *     config can flip it per topic if a specific topic's MCP server count
 *     ever makes deferral not worth it.
 *
 * v0.1.42 host overrides:
 *   - `disallowedTools` removes provider-native AskUserQuestion, Agent, and
 *     Task* tools from the schema/catalog. Otium owns those surfaces via
 *     runtime ask_user_question/spawn_subagent and the shared task MCP server
 *     so state survives agent switches.
 *
 * If a future override becomes per-call (cwd-aware, topic-aware, etc.)
 * we lift the static spread into a per-call wrapper. For now the
 * overrides are uniform across every maestro turn, so a single
 * Object.assign keeps the surface trivial.
 */

import "#platform/maestro-bootstrap-env";
import type { HookRegistration, McpResolver } from "maestro-agent-sdk";
import { maestroProvider as sdkMaestroProvider, setMcpResolver } from "maestro-agent-sdk";
import { deepMapStrings } from "#agents/deep-map";
import {
  hostedMcpServers,
  redactHostedSecrets,
  referencesHostedSecretStorage,
  substituteHostedSecrets,
} from "#agents/execution-host";
import { shouldSubstituteVaultToolInput } from "#agents/vault-tool-policy";
import { vaultGetValue } from "#storage/vault";
import type { AgentQueryOptions, UnifiedEvent } from "#types";

/**
 * Default per-API-call max output tokens for every Otium maestro turn.
 * See the file-level docstring for the rationale; callers override per call
 * via `AgentQueryOptions.maxTokens`.
 */
const MAESTRO_DEFAULT_MAX_TOKENS = 32_768;
const PROVIDER_ASK_USER_TOOL = "AskUserQuestion";
const PROVIDER_SUBAGENT_TOOL = "Agent";
const MAESTRO_NATIVE_TASK_TOOLS = [
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskOutput",
  "TaskStop",
] as const;
const MAESTRO_PROVIDER_OWNED_TOOL_SET = new Set<string>([
  PROVIDER_ASK_USER_TOOL,
  PROVIDER_SUBAGENT_TOOL,
  ...MAESTRO_NATIVE_TASK_TOOLS,
]);
const DEFAULT_MAESTRO_DISALLOWED_TOOLS = [
  PROVIDER_ASK_USER_TOOL,
  PROVIDER_SUBAGENT_TOOL,
  ...MAESTRO_NATIVE_TASK_TOOLS,
] as const;

export function buildMaestroDisallowedTools(
  callerDisallowedTools: readonly string[] = [],
): readonly string[] {
  return [...new Set([...DEFAULT_MAESTRO_DISALLOWED_TOOLS, ...callerDisallowedTools])];
}

/**
 * Build per-call tool hooks:
 *
 * Pre hook — two responsibilities in one pass:
 *   1. Block direct vault.db filesystem access (security guard).
 *   2. Substitute {{KEY}} placeholders immediately before tool execution.
 *
 * Post hook — scrub raw/common encoded secret forms before tool output is sent
 * back to the model.
 */
function buildVaultHook(userId: string): HookRegistration {
  return {
    name: "vault-guard",
    pre({ toolName, input }) {
      if (referencesHostedSecretStorage(input)) {
        return { decision: "block", error: "Runtime secret storage access is not permitted" };
      }

      if (!shouldSubstituteVaultToolInput(toolName)) return { decision: "allow" };

      const substituted = deepMapStrings(input, (value) => substituteHostedSecrets(userId, value));
      return JSON.stringify(substituted) === JSON.stringify(input)
        ? { decision: "allow" }
        : { decision: "modify", input: substituted as Record<string, unknown> };
    },
    post({ output }) {
      const redacted = redactHostedSecrets(userId, output);
      return redacted === output ? {} : { output: redacted };
    },
  };
}

export function buildMaestroToolHooks(userId: string): HookRegistration[] {
  return [buildVaultHook(userId), buildProviderOwnedToolBlockHook()];
}

function providerOwnedToolRedirect(toolName: string): string {
  if (toolName === PROVIDER_ASK_USER_TOOL) {
    return "Use the runtime ask_user_question MCP tool instead.";
  }
  if (toolName === PROVIDER_SUBAGENT_TOOL) {
    return "Use the runtime spawn_subagent MCP tool instead.";
  }
  return (
    "Use the shared task MCP tools instead " +
    "(mcp__task__task_create / task_update / task_list / task_get / task_delete)."
  );
}

/**
 * Resolve per-user DeepSeek/Kimi credentials from Vault before falling back
 * to the process-wide `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` env vars (see
 * `maestro-agent-sdk`'s `AgentQueryOptions.apiKeyOverrides`).
 *
 * Passed explicitly per call rather than written into `process.env` — this
 * process serves every topic/user concurrently, so mutating the shared env
 * would let one user's Maestro call race another's key onto the wire.
 */
export function resolveMaestroApiKeyOverrides(
  userId: string,
): { deepseek?: string; moonshot?: string } | undefined {
  if (!userId) return undefined;
  const deepseek = vaultGetValue(userId, "DEEPSEEK_API_KEY")?.trim();
  const moonshot = vaultGetValue(userId, "MOONSHOT_API_KEY")?.trim();
  if (!deepseek && !moonshot) return undefined;
  return {
    ...(deepseek ? { deepseek } : {}),
    ...(moonshot ? { moonshot } : {}),
  };
}

function buildProviderOwnedToolBlockHook(): HookRegistration {
  return {
    name: "provider-owned-tool-redirect",
    pre({ toolName }) {
      if (!MAESTRO_PROVIDER_OWNED_TOOL_SET.has(toolName)) return { decision: "allow" };
      return {
        decision: "block",
        error: `${toolName} is disabled in this environment. ${providerOwnedToolRedirect(toolName)}`,
      };
    },
  };
}

export function maestroProvider(opts: AgentQueryOptions): AsyncGenerator<UnifiedEvent> {
  // Dispatcher guarantees agent === "maestro" before routing here; throw early
  // so routing bugs surface at the call site rather than silently overwriting.
  if (opts.agent !== undefined && opts.agent !== "maestro") {
    throw new Error(`maestroProvider: unexpected agent "${opts.agent}", expected "maestro"`);
  }
  const userId = opts.userId ?? "";
  // The SDK deliberately ships with an empty MCP resolver. Keep this wiring in
  // the provider adapter rather than every host bootstrap so a new Negotium
  // channel cannot accidentally run Maestro with zero runtime/wiki/task MCPs.
  setMcpResolver(hostedMcpServers as McpResolver);
  const callerDisallowedTools = opts.disallowedTools ?? [];
  const callerToolHooks = (opts as { toolHooks?: HookRegistration[] }).toolHooks ?? [];
  // maestro-agent-sdk's type does not yet include Otium's "cron" sessionType;
  // keep the runtime value intact so the host MCP resolver can choose cron scope.
  const sdkOpts = {
    // Built-in background bash (Bash/BashOutput/KillBash triad) is disabled
    // because its completion never triggers a new model turn in this headless
    // setup — the bash runs in the bot process but when the turn ends nobody
    // polls it. Use mcp__background-bash__background_bash_run instead, which
    // injects a session-inbox tell entry on exit so the loop closes properly.
    enableBackgroundBash: false,
    maxTokens: MAESTRO_DEFAULT_MAX_TOKENS,
    enableToolSearch: true,
    ...opts,
    // Resolve this after spreading caller options so untrusted runtime input
    // cannot replace a topic owner's Vault credentials with another key.
    apiKeyOverrides: resolveMaestroApiKeyOverrides(userId),
    // v0.1.39: SDK AgentQueryOptions.agent is narrowed to "maestro" only.
    // Otium's AgentKind is wider ("claude"|"codex"|"maestro"), so stamp
    // the literal to satisfy the SDK type.
    agent: "maestro",
    disallowedTools: buildMaestroDisallowedTools(callerDisallowedTools),
    toolHooks: [...buildMaestroToolHooks(userId), ...callerToolHooks],
  } as unknown as Parameters<typeof sdkMaestroProvider>[0];
  return sdkMaestroProvider(sdkOpts);
}
