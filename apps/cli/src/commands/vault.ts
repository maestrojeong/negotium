/**
 * `negotium vault <list|set|get|del>` — node secret store.
 *
 * Values are AES-encrypted at rest with the per-node master key
 * (~/.negotium/vault-master-key, or NEGOTIUM_VAULT_MASTER_KEY). The vault is a
 * core system: agents/MCPs read it through the runtime, humans through here.
 */

import {
  normalizeVaultKey,
  validateVaultKey,
  vaultDel,
  vaultListWithValues,
  vaultSet,
} from "@negotium/core";

const DEFAULT_USER = "local";

export function vaultCommand(args: string[]): void {
  const [sub, key, value, ...descParts] = args;

  switch (sub) {
    case undefined:
    case "list": {
      const entries = vaultListWithValues(DEFAULT_USER);
      if (entries.length === 0) {
        console.log("vault is empty — `negotium vault set MY_KEY <value> [description]`");
        return;
      }
      for (const entry of entries) {
        console.log(`${entry.key}  ${entry.description || ""}`.trimEnd());
      }
      return;
    }
    case "set": {
      if (!key || !value) {
        console.error("usage: negotium vault set <KEY> <value> [description]");
        process.exitCode = 1;
        return;
      }
      const normalized = normalizeVaultKey(key);
      if (!validateVaultKey(normalized)) {
        console.error("invalid key — use A-Z, 0-9, _ (must start with a letter, max 128 chars)");
        process.exitCode = 1;
        return;
      }
      vaultSet(DEFAULT_USER, normalized, value, descParts.join(" "));
      console.log(`stored ${normalized}`);
      return;
    }
    case "get": {
      if (!key) {
        console.error("usage: negotium vault get <KEY>");
        process.exitCode = 1;
        return;
      }
      const entry = vaultListWithValues(DEFAULT_USER).find((e) => e.key === normalizeVaultKey(key));
      if (!entry) {
        console.error(`no such key "${key}"`);
        process.exitCode = 1;
        return;
      }
      console.log(entry.value);
      return;
    }
    case "del": {
      if (!key) {
        console.error("usage: negotium vault del <KEY>");
        process.exitCode = 1;
        return;
      }
      console.log(
        vaultDel(DEFAULT_USER, normalizeVaultKey(key)) ? `deleted ${key}` : `no such key "${key}"`,
      );
      return;
    }
    default:
      console.error(`unknown subcommand "${sub}" — use list|set|get|del`);
      process.exitCode = 1;
  }
}
