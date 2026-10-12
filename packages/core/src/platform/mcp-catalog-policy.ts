export type RuntimeMcpScope = "dm" | "forum" | "fork" | "manager" | "cron";

export interface RuntimeMcpPolicyEntry {
  scopes: readonly RuntimeMcpScope[];
  /** Forum entries marked required cannot be disabled by a topic whitelist. */
  forumRequired?: boolean;
  /**
   * The server replaces the default browser and background shell: a room that
   * enables it gets neither, from its first turn on (stable tool prefix). For
   * special-purpose rooms, the same way General keeps a lean bundle.
   */
  replacesBrowser?: boolean;
  /**
   * Subagents normally start with required servers only (no optional
   * whitelist cascade). A server marked here is the exception: when the
   * parent room has it enabled, the work it delegates needs it too.
   */
  followsIntoSubagents?: boolean;
}

export const COMMON_RUNTIME_MCP_POLICY = {
  playwright: { scopes: ["dm", "forum", "fork", "cron"], forumRequired: true },
  runtime: { scopes: ["forum", "manager", "fork", "cron"], forumRequired: true },
  "token-stats": { scopes: ["dm", "forum", "manager", "cron"], forumRequired: true },
  task: { scopes: ["dm", "forum", "manager", "cron"], forumRequired: true },
  decision: { scopes: ["dm", "forum", "manager", "cron"], forumRequired: true },
  "session-comm": { scopes: ["forum", "fork", "manager"], forumRequired: true },
  wiki: { scopes: ["dm", "forum", "manager", "cron"], forumRequired: true },
  skills: { scopes: ["dm", "forum", "manager", "cron"], forumRequired: true },
  "system-health": { scopes: ["dm", "forum", "manager", "cron"], forumRequired: true },
  "background-bash": { scopes: ["forum"], forumRequired: true },
  "agent-health": { scopes: ["forum", "manager", "cron"], forumRequired: true },
  vault: { scopes: ["dm", "forum", "manager", "cron"], forumRequired: true },
  // macOS desktop control via maestrojeong/cua-rs. Deliberately NOT
  // forumRequired: it advertises 12 tools, a meaningful slice of a turn's
  // tool budget, and most topics never touch a native app. Opt in per topic
  // through the enabled whitelist.
  "cua-rs": { scopes: ["dm", "forum", "fork"], forumRequired: false },
  // Korean tax and social-insurance portal workflows via the separately run
  // tax-rs server. Opt in per topic. Portal work in such a room must go
  // through its workflow tools only, never a general browser, and the
  // room's delegated agency jobs need the same tools.
  tax: {
    scopes: ["forum", "fork"],
    forumRequired: false,
    replacesBrowser: true,
    followsIntoSubagents: true,
  },
} as const satisfies Record<string, RuntimeMcpPolicyEntry>;

function policyFlag(name: string, flag: "replacesBrowser" | "followsIntoSubagents"): boolean {
  const entry: RuntimeMcpPolicyEntry | undefined =
    COMMON_RUNTIME_MCP_POLICY[name as CommonRuntimeMcpName];
  return Boolean(entry?.[flag]);
}

/** True when an enabled server replaces the default browser and background shell. */
export function isBrowserlessMcpSet(enabled: readonly string[] | null | undefined): boolean {
  return Boolean(enabled?.some((name) => policyFlag(name, "replacesBrowser")));
}

/** The parent's enabled servers a spawned subagent keeps. */
export function subagentInheritedMcp(
  parentEnabled: readonly string[] | null | undefined,
): string[] {
  return (parentEnabled ?? []).filter((name) => policyFlag(name, "followsIntoSubagents"));
}

export type CommonRuntimeMcpName = keyof typeof COMMON_RUNTIME_MCP_POLICY;

export interface ForumMcpClassification {
  all: string[];
  required: string[];
  optional: string[];
}

export function classifyForumMcpServers(
  catalog: Readonly<Record<string, RuntimeMcpPolicyEntry>>,
): ForumMcpClassification {
  const all = Object.entries(catalog)
    .filter(([, entry]) => entry.scopes.includes("forum"))
    .map(([name]) => name);
  const required = Object.entries(catalog)
    .filter(([, entry]) => entry.scopes.includes("forum") && entry.forumRequired)
    .map(([name]) => name);
  const requiredSet = new Set(required);
  return { all, required, optional: all.filter((name) => !requiredSet.has(name)) };
}

export function commonRuntimeMcpPolicy(name: CommonRuntimeMcpName): RuntimeMcpPolicyEntry {
  return COMMON_RUNTIME_MCP_POLICY[name];
}

export function isForumRequiredMcp(name: string): boolean {
  const entry = COMMON_RUNTIME_MCP_POLICY[name as CommonRuntimeMcpName];
  return Boolean(entry?.scopes.includes("forum") && entry.forumRequired);
}
