import {
  normalizeVaultKey,
  VAULT_DESCRIPTION_MAX_LENGTH,
  VAULT_VALUE_MAX_BYTES,
  VAULT_VALUE_MIN_BYTES,
  validateVaultKey,
  vaultDel,
  vaultHasKey,
  vaultList,
  vaultSet,
} from "#storage/vault";

export const VAULT_COMMAND_HELP = [
  "Vault commands:",
  "/vault list",
  "/vault set KEY VALUE [description]",
  "/vault set KEY value with spaces | optional description",
  "/vault del KEY",
  "Use {{KEY}} in agent tool requests. Secret values are never shown to the agent.",
].join("\n");

const VAULT_COMMAND_PATTERN = /^\/vault(?:@\w+)?(?:\s|$)/i;

export function isVaultCommandLine(commandLine: string): boolean {
  return VAULT_COMMAND_PATTERN.test(commandLine.trim());
}

function parseSetValue(rest: string): { value: string; description: string } {
  const pipe = rest.match(/\s+\|\s*/);
  if (pipe?.index !== undefined) {
    return {
      value: rest.slice(0, pipe.index).trimEnd(),
      description: rest.slice(pipe.index + pipe[0].length).trim(),
    };
  }

  const [value = "", ...description] = rest.trim().split(/\s+/);
  return { value, description: description.join(" ") };
}

type VaultEntry = { key: string; description: string };

function renderVaultPanel(entries: VaultEntry[]): string {
  const lines: string[] = [
    "Vault",
    "Store API keys and tokens locally. Use {{KEY}} in agent tool requests.",
    "Secret values are never displayed.",
    "",
    "Keys:",
  ];

  if (entries.length === 0) {
    lines.push("- (empty)");
  } else {
    for (const e of entries) {
      lines.push(e.description ? `- ${e.key}: ${e.description}` : `- ${e.key}`);
    }
  }

  lines.push(
    "",
    "Commands:",
    "/vault set KEY VALUE | optional description",
    "/vault del KEY",
    "/vault list",
  );

  return lines.join("\n");
}

/** Execute a human-facing Vault command without returning secret plaintext. */
export function executeVaultCommand(userId: string, commandLine: string): string | null {
  const input = commandLine.trim();
  if (!isVaultCommandLine(input)) return null;

  const commandMatch = input.match(/^\/vault(?:@\w+)?(?:\s+([^\s]+))?/i);
  const subcommand = commandMatch?.[1]?.toLowerCase();

  if (!subcommand) {
    const entries = vaultList(userId);
    return renderVaultPanel(entries);
  }

  if (subcommand === "list") {
    const entries = vaultList(userId);
    if (entries.length === 0) return "Vault is empty.";
    return [
      `Vault keys (${entries.length}):`,
      ...entries.map((entry) =>
        entry.description ? `- ${entry.key}: ${entry.description}` : `- ${entry.key}`,
      ),
    ].join("\n");
  }

  if (subcommand === "del") {
    const match = input.match(/^\/vault(?:@\w+)?\s+del\s+(\S+)\s*$/i);
    if (!match?.[1]) return "Usage: /vault del KEY";
    const key = normalizeVaultKey(match[1]);
    if (!validateVaultKey(key)) {
      return "Invalid key. Use A-Z, 0-9, and _; start with a letter (max 128 characters).";
    }
    return vaultDel(userId, key) ? `Deleted ${key}.` : `No Vault key named ${key}.`;
  }

  if (subcommand === "set") {
    const match = input.match(/^\/vault(?:@\w+)?\s+set\s+(\S+)(?:\s+([\s\S]+))?$/i);
    if (!match?.[1] || !match[2]) return "Usage: /vault set KEY VALUE [description]";

    const key = normalizeVaultKey(match[1]);
    if (!validateVaultKey(key)) {
      return "Invalid key. Use A-Z, 0-9, and _; start with a letter (max 128 characters).";
    }

    const { value, description } = parseSetValue(match[2]);
    if (!value) return "Vault value cannot be empty.";
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (valueBytes < VAULT_VALUE_MIN_BYTES) {
      return `Vault value must be at least ${VAULT_VALUE_MIN_BYTES} bytes.`;
    }
    if (valueBytes > VAULT_VALUE_MAX_BYTES) {
      return `Vault value must not exceed ${VAULT_VALUE_MAX_BYTES} bytes.`;
    }
    if (description.length > VAULT_DESCRIPTION_MAX_LENGTH) {
      return `Vault description must not exceed ${VAULT_DESCRIPTION_MAX_LENGTH} characters.`;
    }
    const existed = vaultHasKey(userId, key);
    vaultSet(userId, key, value, description);
    return `${existed ? "Updated" : "Stored"} ${key}.`;
  }

  return VAULT_COMMAND_HELP;
}
