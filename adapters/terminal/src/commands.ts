export interface TerminalCommand {
  name: string;
  usage: string;
  description: string;
}

export const TERMINAL_COMMANDS: readonly TerminalCommand[] = [
  { name: "new", usage: "/new", description: "reset the current session" },
  { name: "compact", usage: "/compact", description: "summarize and shrink context" },
  { name: "status", usage: "/status", description: "show model and token usage" },
  { name: "model", usage: "/model", description: "choose the model" },
  { name: "topics", usage: "/topics", description: "open topic picker" },
  { name: "del", usage: "/del", description: "delete the current topic" },
  { name: "copy", usage: "/copy [all]", description: "copy answer or transcript" },
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
