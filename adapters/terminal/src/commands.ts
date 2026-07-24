export interface TerminalCommand {
  name: string;
  usage: string;
  description: string;
}

const TERMINAL_COMMANDS: readonly TerminalCommand[] = [
  { name: "new", usage: "/new", description: "reset the current session" },
  { name: "compact", usage: "/compact", description: "summarize and shrink context" },
  { name: "status", usage: "/status", description: "show model and token usage" },
  { name: "model", usage: "/model", description: "choose the model" },
  { name: "effort", usage: "/effort", description: "choose reasoning effort" },
  { name: "topics", usage: "/topics", description: "open topic picker" },
  { name: "public", usage: "/public", description: "share this topic with Otium Hub" },
  { name: "private", usage: "/private", description: "make this topic local-only" },
  {
    name: "fork",
    usage: "/fork [name]",
    description: "fork this topic (config + history) into a new one",
  },
  {
    name: "spawn",
    usage: "/spawn [name]",
    description: "spawn a new topic from this one's config (fresh session)",
  },
  { name: "del", usage: "/del", description: "delete the current topic" },
  { name: "copy", usage: "/copy", description: "copy the last answer" },
  {
    name: "vault",
    usage: "/vault [list|set|del]",
    description: "open the Vault editor or run a compact Vault command",
  },
  { name: "abort", usage: "/abort", description: "stop the active turn" },
  { name: "help", usage: "/help", description: "show keyboard help" },
  { name: "quit", usage: "/quit", description: "exit Terminal" },
];

export function commandSuggestions(input: string): TerminalCommand[] {
  if (!input.startsWith("/") || input.includes("\n")) return [];
  const token = input.slice(1);
  if (token.includes(" ")) return [];
  const normalized = token.toLowerCase();
  return TERMINAL_COMMANDS.filter((command) => command.name.startsWith(normalized));
}

export function completeCommand(input: string, index: number): string | null {
  const suggestions = commandSuggestions(input);
  if (suggestions.length === 0) return null;
  const selected = suggestions[(index + suggestions.length) % suggestions.length];
  return `${selected.usage.includes("<") || selected.usage.includes("[") ? `/${selected.name} ` : `/${selected.name}`}`;
}
