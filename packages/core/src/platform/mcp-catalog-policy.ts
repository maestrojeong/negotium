export type RuntimeMcpScope = "dm" | "forum" | "fork" | "manager" | "cron";

export interface RuntimeMcpPolicyEntry {
  scopes: readonly RuntimeMcpScope[];
  /** Forum entries marked required cannot be disabled by a topic whitelist. */
  forumRequired?: boolean;
}

export const COMMON_RUNTIME_MCP_POLICY = {
  playwright: { scopes: ["dm", "forum", "fork", "cron"], forumRequired: true },
  runtime: { scopes: ["forum", "manager", "fork", "cron"], forumRequired: true },
  "token-stats": { scopes: ["dm", "forum", "manager", "cron"], forumRequired: true },
  task: { scopes: ["dm", "forum", "manager", "cron"], forumRequired: true },
  "session-comm": { scopes: ["forum", "fork", "manager"], forumRequired: true },
  wiki: { scopes: ["dm", "forum", "manager", "cron"], forumRequired: true },
  skills: { scopes: ["dm", "forum", "manager", "cron"], forumRequired: true },
  "system-health": { scopes: ["dm", "forum", "manager", "cron"], forumRequired: true },
  "background-bash": { scopes: ["forum"], forumRequired: true },
  "agent-health": { scopes: ["forum", "manager", "cron"], forumRequired: true },
  vault: { scopes: ["dm", "forum", "manager", "cron"], forumRequired: true },
} as const satisfies Record<string, RuntimeMcpPolicyEntry>;

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
