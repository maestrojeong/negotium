import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactVaultSecrets, vaultGetValue, vaultSubstituteDetailed } from "#storage/vault-public";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_OUTPUT_LIMIT = 100_000;
const LEASE_TTL_MS = 5 * 60_000;
const MAX_ACTIVE_LEASES = 1_024;
const BOUNDED_OUTPUTS: Record<string, { argument: string; field: string }> = {
  browser_snapshot: { argument: "maxLength", field: "snapshot" },
  browser_api_request: { argument: "maxBytes", field: "body" },
  browser_get_visible_text: { argument: "maxLength", field: "text" },
  browser_get_visible_html: { argument: "maxLength", field: "html" },
  // browser-rs 0.1.17's own `maxLength` doc comment: "Managed hosts may raise
  // this so secrets are redacted before the caller-visible limit is applied."
  // `field` is unused here (the tool returns a plain string, not `{content}`
  // JSON — see `redactTextEntry`'s non-JSON fallback), but the `argument`
  // override is what matters: it raises the request to MAX_SAFE_INTEGER so
  // browser-rs never truncates a secret mid-string before redaction sees it.
  browser_iframe_read: { argument: "maxLength", field: "content" },
};

interface RedactionBoundary {
  field: string;
  limit: number;
}

export interface BrowserVaultBrokerHandle {
  readonly socketPath: string;
  readonly token: string;
  close(): Promise<void>;
}

function deepMapStrings(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((entry) => deepMapStrings(entry, transform));
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, deepMapStrings(entry, transform)]),
  );
}

function encodedSecretForms(value: string): string[] {
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
    .sort((left, right) => right.length - left.length);
}

function prepareInput(
  tool: string,
  value: unknown,
): { value: unknown; boundary?: RedactionBoundary } {
  const config = BOUNDED_OUTPUTS[tool];
  if (!config || !value || typeof value !== "object" || Array.isArray(value)) return { value };
  const input = value as Record<string, unknown>;
  const requested = input[config.argument];
  if (requested !== undefined && (!Number.isSafeInteger(requested) || Number(requested) <= 0)) {
    return { value };
  }
  const limit = requested === undefined ? DEFAULT_OUTPUT_LIMIT : Number(requested);
  return {
    value: { ...input, [config.argument]: Number.MAX_SAFE_INTEGER },
    boundary: { field: config.field, limit },
  };
}

function redactTextEntry(
  entry: unknown,
  redact: (value: unknown) => unknown,
  boundary?: RedactionBoundary,
): unknown {
  if (!entry || typeof entry !== "object") return redact(entry);
  const content = entry as Record<string, unknown>;
  if (content.type !== "text" || typeof content.text !== "string") return redact(entry);
  try {
    const parsed = redact(JSON.parse(content.text));
    if (boundary && parsed && typeof parsed === "object") {
      const object = parsed as Record<string, unknown>;
      const fieldValue = object[boundary.field];
      if (typeof fieldValue === "string") {
        const originalExceeded =
          typeof object.length === "number" && object.length > boundary.limit;
        if (fieldValue.length > boundary.limit)
          object[boundary.field] = fieldValue.slice(0, boundary.limit);
        if (originalExceeded || fieldValue.length > boundary.limit) object.truncated = true;
      }
    }
    return { ...content, text: JSON.stringify(parsed, null, 2) };
  } catch {
    const redacted = redact(content.text);
    if (boundary && typeof redacted === "string" && redacted.length > boundary.limit) {
      return {
        ...content,
        text: `${redacted.slice(0, boundary.limit)}\n[truncated]`,
      };
    }
    return { ...content, text: redacted };
  }
}

function secureOutput(
  result: unknown,
  redact: (value: unknown) => unknown,
  boundary?: RedactionBoundary,
): unknown {
  if (!result || typeof result !== "object") return redact(result);
  const object = result as Record<string, unknown>;
  const content = Array.isArray(object.content)
    ? object.content.map((entry) => redactTextEntry(entry, redact, boundary))
    : object.content;
  return redact({ ...object, content });
}

function authorized(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createBrowserVaultBroker(userId: string): Promise<BrowserVaultBrokerHandle> {
  const token = randomBytes(32).toString("hex");
  const socketPath = join(
    process.platform === "win32" ? tmpdir() : "/tmp",
    `negotium-browser-vault-${process.pid}-${randomBytes(8).toString("hex")}.sock`,
  );
  const retainedForms = new Map<string, string>();
  const leases = new Map<string, { boundary?: RedactionBoundary; createdAt: number }>();
  const sockets = new Set<Socket>();

  const redactRetained = (text: string): string => {
    let output = text;
    for (const [form, key] of [...retainedForms].sort(
      ([left], [right]) => right.length - left.length,
    )) {
      output = output.replaceAll(form, `[REDACTED:${key}]`);
    }
    return output;
  };
  const redact = (value: unknown): unknown =>
    deepMapStrings(value, (text) => redactRetained(redactVaultSecrets(userId, text)));

  const handleRequest = (request: Record<string, unknown>): Record<string, unknown> => {
    const id = request.id;
    if (!authorized(request.token, token)) return { id, ok: false, error: "unauthorized" };
    if (request.op === "transform_input") {
      if (typeof request.tool !== "string") return { id, ok: false, error: "invalid tool" };
      const leaseCutoff = Date.now() - LEASE_TTL_MS;
      for (const [lease, binding] of leases) {
        if (binding.createdAt < leaseCutoff) leases.delete(lease);
      }
      if (leases.size >= MAX_ACTIVE_LEASES) {
        return { id, ok: false, error: "too many active leases" };
      }
      const substituted = deepMapStrings(request.value, (text) => {
        const result = vaultSubstituteDetailed(userId, text);
        for (const key of result.usedKeys) {
          const secret = vaultGetValue(userId, key);
          if (secret === undefined) continue;
          for (const form of encodedSecretForms(secret)) retainedForms.set(form, key);
        }
        return result.text;
      });
      const prepared = prepareInput(request.tool, substituted);
      const lease = randomBytes(24).toString("hex");
      leases.set(lease, { boundary: prepared.boundary, createdAt: Date.now() });
      return {
        id,
        ok: true,
        value: prepared.value,
        lease,
        boundary: prepared.boundary,
      };
    }
    if (request.op === "redact_output") {
      if (typeof request.lease !== "string") {
        return { id, ok: false, error: "invalid lease" };
      }
      const binding = leases.get(request.lease);
      leases.delete(request.lease);
      if (!binding || binding.createdAt < Date.now() - LEASE_TTL_MS) {
        return { id, ok: false, error: "invalid lease" };
      }
      try {
        const value = secureOutput(request.value, redact, binding.boundary);
        const serialized = JSON.stringify(value);
        if (redactRetained(serialized) !== serialized) {
          return { id, ok: false, error: "redaction verification failed" };
        }
        return { id, ok: true, value };
      } catch {
        return { id, ok: false, error: "redaction failed" };
      }
    }
    return { id, ok: false, error: "unknown operation" };
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line) continue;
        let response: Record<string, unknown>;
        try {
          response = handleRequest(JSON.parse(line) as Record<string, unknown>);
        } catch {
          response = { ok: false, error: "invalid request" };
        }
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolveListen);
  });
  chmodSync(socketPath, 0o600);
  let closed = false;

  return {
    socketPath,
    token,
    async close() {
      if (closed) return;
      closed = true;
      leases.clear();
      retainedForms.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
