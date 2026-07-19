import type { VaultCredentialHost } from "#mcp/factories/vault-host";

const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "location",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-authorization",
  "transfer-encoding",
]);

export interface VaultHttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface VaultHttpResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  truncated?: boolean;
  error?: string;
}

function substituteObject(
  userId: string,
  values: Record<string, string>,
  host: VaultCredentialHost,
): { values: Record<string, string>; usedKeys: string[] } {
  const used = new Set<string>();
  const substituted: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (FORBIDDEN_REQUEST_HEADERS.has(key.toLowerCase())) {
      throw new Error(`Header "${key}" is not allowed`);
    }
    const result = host.substitute(userId, value);
    for (const usedKey of result.usedKeys) used.add(usedKey);
    substituted[key] = result.text;
  }
  return { values: substituted, usedKeys: [...used] };
}

function safeResponseHeaders(
  userId: string,
  headers: Headers,
  host: VaultCredentialHost,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (!SAFE_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    output[key] = host.redact(userId, value);
  }
  return output;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let keptBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = maxBytes - keptBytes;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      const visible = next.value.subarray(0, remaining);
      chunks.push(visible);
      keptBytes += visible.byteLength;
      if (visible.byteLength < next.value.byteLength) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(keptBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

/**
 * Execute an HTTPS request inside the credential boundary. The caller supplies
 * only {{KEY}} references; expanded headers/body never leave this function.
 */
export async function executeVaultHttpRequest(
  userId: string,
  request: VaultHttpRequest,
  host: VaultCredentialHost,
  fetchImpl: typeof fetch = fetch,
): Promise<VaultHttpResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return { ok: false, error: "url must be an absolute HTTPS URL" };
  }
  if (parsedUrl.protocol !== "https:") {
    return {
      ok: false,
      error: "Vault credentials may only be sent over HTTPS",
    };
  }
  if (parsedUrl.username || parsedUrl.password || /\{\{[^}]+\}\}/.test(request.url)) {
    return {
      ok: false,
      error: "Keep Vault placeholders out of URLs; put credentials in headers or body",
    };
  }

  let headers: Record<string, string>;
  let headerKeys: string[];
  try {
    const substituted = substituteObject(userId, request.headers ?? {}, host);
    headers = substituted.values;
    headerKeys = substituted.usedKeys;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const bodyResult =
    request.body === undefined
      ? { text: undefined, usedKeys: [] as string[] }
      : host.substitute(userId, request.body);
  const usedKeys = [...new Set([...headerKeys, ...bodyResult.usedKeys])].sort();
  if (usedKeys.length === 0) {
    return {
      ok: false,
      error: "No valid Vault placeholder was found in headers or body",
    };
  }
  if (request.method === "GET" && request.body !== undefined) {
    return {
      ok: false,
      error: "GET requests cannot include a credential-bearing body",
    };
  }

  const controller = new AbortController();
  const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 30_000, 1_000), 120_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(parsedUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : bodyResult.text,
      redirect: "manual",
      signal: controller.signal,
    });
    const maxBytes = Math.min(Math.max(request.maxResponseBytes ?? 256 * 1024, 1_024), 1024 * 1024);
    const { bytes, truncated } = await readBoundedBody(response, maxBytes);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const textual =
      contentType.startsWith("text/") ||
      contentType.includes("json") ||
      contentType.includes("xml") ||
      contentType.includes("javascript") ||
      contentType === "";
    const body = textual
      ? host.redact(userId, new TextDecoder().decode(bytes))
      : `[binary response omitted: ${bytes.byteLength} bytes, ${contentType || "unknown content type"}]`;

    host.log?.(
      "info",
      {
        userId,
        vaultKeys: usedKeys,
        host: parsedUrl.hostname,
        method: request.method,
        status: response.status,
        durationMs: Date.now() - startedAt,
      },
      "vault credential used",
    );

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: safeResponseHeaders(userId, response.headers, host),
      body,
      truncated,
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    host.log?.(
      "warn",
      {
        userId,
        vaultKeys: usedKeys,
        host: parsedUrl.hostname,
        method: request.method,
        durationMs: Date.now() - startedAt,
      },
      "vault credential request failed",
    );
    return { ok: false, error: host.redact(userId, raw) };
  } finally {
    clearTimeout(timeout);
  }
}
