import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function deepMapStrings(value, transform) {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((entry) => deepMapStrings(entry, transform));
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, deepMapStrings(entry, transform)]),
  );
}

export async function createBrowserVaultTransforms(userId) {
  if (!userId) return { substitute: (value) => value, redact: (value) => value };

  const { register } = await import("tsx/esm/api");
  register();
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const vault = await import(
    pathToFileURL(resolve(scriptDir, "../src/storage/vault-public.ts")).href
  );

  return {
    substitute(value) {
      return deepMapStrings(value, (text) => vault.vaultSubstituteDetailed(userId, text).text);
    },
    redact(value) {
      return deepMapStrings(value, (text) => vault.redactVaultSecrets(userId, text));
    },
  };
}
