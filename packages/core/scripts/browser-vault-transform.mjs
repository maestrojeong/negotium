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

function encodedSecretForms(value) {
  return [
    ...new Set([
      value,
      encodeURIComponent(value),
      Buffer.from(value, "utf8").toString("base64"),
      Buffer.from(value, "utf8").toString("base64url"),
      Buffer.from(value, "utf8").toString("hex"),
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

const DEFAULT_BROWSER_OUTPUT_LIMIT = 100_000;
const BOUNDED_BROWSER_OUTPUTS = {
  browser_snapshot: { argument: "maxLength", field: "snapshot" },
  browser_api_request: { argument: "maxBytes", field: "body" },
  browser_get_visible_text: { argument: "maxLength", field: "text" },
  browser_get_visible_html: { argument: "maxLength", field: "html" },
};

export function prepareBrowserToolInputForRedaction(toolName, input) {
  const config = BOUNDED_BROWSER_OUTPUTS[toolName];
  if (!config || !input || typeof input !== "object" || Array.isArray(input)) {
    return { input, boundary: undefined };
  }
  const requested = input[config.argument];
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested <= 0)) {
    // Preserve upstream schema validation for malformed limits.
    return { input, boundary: undefined };
  }
  const limit = requested ?? DEFAULT_BROWSER_OUTPUT_LIMIT;
  return {
    input: {
      ...input,
      // The upstream handler must return the complete field. The canonical
      // postprocessor redacts it before restoring the caller/default limit.
      [config.argument]: Number.MAX_SAFE_INTEGER,
    },
    boundary: { field: config.field, limit },
  };
}

function redactTextContent(entry, redact, boundary) {
  if (!entry || entry.type !== "text" || typeof entry.text !== "string") return redact(entry);
  try {
    const parsed = redact(JSON.parse(entry.text));
    if (boundary && parsed && typeof parsed === "object") {
      const value = parsed[boundary.field];
      if (typeof value === "string") {
        const originalExceededLimit =
          typeof parsed.length === "number" && parsed.length > boundary.limit;
        if (value.length > boundary.limit) {
          parsed[boundary.field] = value.slice(0, boundary.limit);
        }
        if (originalExceededLimit || value.length > boundary.limit) parsed.truncated = true;
      }
    }
    return { ...entry, text: JSON.stringify(parsed, null, 2) };
  } catch {
    return { ...entry, text: redact(entry.text) };
  }
}

export function redactBrowserToolOutputBeforeBounding(result, redact, boundary) {
  if (!result || typeof result !== "object") return redact(result);
  const content = Array.isArray(result.content)
    ? result.content.map((entry) => redactTextContent(entry, redact, boundary))
    : result.content;
  return redact({ ...result, content });
}

function redactionFailureResult() {
  return {
    content: [
      { type: "text", text: "Browser output was blocked because secure redaction failed." },
    ],
    isError: true,
  };
}

export async function createBrowserVaultTransforms(userId) {
  if (!userId) {
    return {
      substitute: (value) => value,
      redact: (value) => value,
      postprocess: (result, boundary) =>
        redactBrowserToolOutputBeforeBounding(result, (value) => value, boundary),
    };
  }

  const { register } = await import("tsx/esm/api");
  register();
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const vault = await import(
    pathToFileURL(resolve(scriptDir, "../src/storage/vault-public.ts")).href
  );

  // Keep every value expanded into the browser for the lifetime of this
  // gateway. A later snapshot can still contain an old value after the Vault
  // entry has been rotated or deleted, so querying only the current Vault at
  // output time is insufficient.
  const retainedForms = new Map();
  const retainUsedKeys = (usedKeys, entries) => {
    for (const key of usedKeys) {
      const value = entries.get(key);
      if (value === undefined) continue;
      for (const form of encodedSecretForms(value)) retainedForms.set(form, key);
    }
  };
  const redactRetained = (text) => {
    let output = text;
    for (const [form, key] of [...retainedForms].sort(([a], [b]) => b.length - a.length)) {
      output = output.replaceAll(form, `[REDACTED:${key}]`);
    }
    return output;
  };
  const redact = (value) =>
    deepMapStrings(value, (text) => redactRetained(vault.redactVaultSecrets(userId, text)));

  return {
    substitute(value) {
      const entries = new Map(
        vault.vaultListWithValues(userId).map((entry) => [entry.key, entry.value]),
      );
      return deepMapStrings(value, (text) => {
        const usedKeys = new Set();
        const substituted = text.replace(/\{\{([^}]+)\}\}/g, (match, rawKey) => {
          const key = vault.normalizeVaultKey(rawKey);
          const secret = entries.get(key);
          if (secret === undefined) return match;
          usedKeys.add(key);
          return secret;
        });
        retainUsedKeys(usedKeys, entries);
        return substituted;
      });
    },
    redact,
    postprocess(result, boundary) {
      try {
        const secured = redactBrowserToolOutputBeforeBounding(result, redact, boundary);
        // Serialization happens after this function. Check that serializing the
        // final object cannot reveal a retained raw or encoded credential.
        const serialized = JSON.stringify(secured);
        if (redactRetained(serialized) !== serialized) return redactionFailureResult();
        return secured;
      } catch {
        // Never fall back to the original browser output when redaction fails.
        return redactionFailureResult();
      }
    },
  };
}
