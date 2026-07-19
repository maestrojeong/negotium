export type CliCommandGroup = "Setup" | "Node" | "Workspace" | "Channels";

export interface CliCommandSpec {
  name: string;
  usage: string;
  description: string;
  group: CliCommandGroup;
  aliases?: readonly string[];
}

export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    name: "init",
    usage: "init",
    description: "bootstrap ~/.negotium and check agent auth",
    group: "Setup",
  },
  {
    name: "serve",
    usage: "serve [otium]",
    description: "run the canonical node, optionally with the Otium sidecar",
    group: "Node",
  },
  {
    name: "status",
    usage: "status",
    description: "show the canonical node and adapter processes",
    group: "Node",
  },
  {
    name: "stop",
    usage: "stop [otium|telegram|--all]",
    description: "stop the node, one adapter, or everything",
    group: "Node",
  },
  { name: "topics", usage: "topics", description: "list topics on this node", group: "Workspace" },
  {
    name: "mcp",
    usage: "mcp list|add|remove|enable|disable",
    description: "manage the node MCP manifest",
    group: "Workspace",
  },
  {
    name: "vault",
    usage: "vault list|set|get|del",
    description: "manage encrypted node secrets",
    group: "Workspace",
  },
  {
    name: "cron",
    usage: "cron <command>",
    description: "list/create/inspect/logs/run/pause/resume/restart/kill/reset/delete jobs",
    group: "Workspace",
  },
  {
    name: "terminal",
    usage: "terminal [--embedded|--connect=URL|--port=N]",
    description: "run a Terminal client for the canonical node",
    group: "Channels",
  },
  {
    name: "telegram",
    usage: "telegram",
    description: "run the Telegram adapter",
    group: "Channels",
  },
  {
    name: "otium",
    usage: "otium join|bindings|share|private|leave",
    description: "manage the Otium workspace connection and topic bindings",
    group: "Channels",
  },
];

export function findCliCommand(name: string): CliCommandSpec | undefined {
  return CLI_COMMANDS.find((command) => command.name === name || command.aliases?.includes(name));
}

export function normalizeCliCommand(command: string | undefined): string {
  return command ?? "terminal";
}

export function renderCliHelp(): string {
  const lines = [
    "negotium - turn this computer into an agent node",
    "",
    "usage: negotium [command] [args]",
    "       negotium -v | --version",
  ];
  for (const group of ["Setup", "Node", "Workspace", "Channels"] as const) {
    lines.push("", `${group}:`);
    for (const command of CLI_COMMANDS.filter((candidate) => candidate.group === group)) {
      const aliases = command.aliases?.length ? ` (alias: ${command.aliases.join(", ")})` : "";
      lines.push(`  ${command.usage.padEnd(68)} ${command.description}${aliases}`);
    }
  }
  lines.push(
    "",
    "With no command, Negotium starts a Terminal client.",
    "Terminal clients may run more than once and share one canonical node.",
  );
  return lines.join("\n");
}
