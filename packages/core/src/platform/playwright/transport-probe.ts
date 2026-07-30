import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { browserOwnerCapability } from "#platform/playwright/capability";

const PROBE_OWNER = "__negotium_transport_probe__";
const PROBE_TIMEOUT_MS = 3000;

interface ProbeTransportOptions {
  terminate?: () => Promise<void>;
  timeoutMs?: number;
}

export async function probeMcpTransport(
  transport: Transport,
  options: ProbeTransportOptions = {},
): Promise<boolean> {
  const client = new Client({ name: "negotium-browser-healthcheck", version: "1.0.0" });
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const tools = await Promise.race([
      (async () => {
        await client.connect(transport);
        const result = await client.listTools();
        if (result.tools.length === 0) throw new Error("browser MCP returned no tools");
        await options.terminate?.();
        return result.tools;
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("browser MCP transport probe timed out")),
          options.timeoutMs ?? PROBE_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
    return tools.length > 0;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      await client.close();
    } catch {
      // The probe already failed; close is best-effort for partially opened transports.
    }
  }
}

/**
 * Exercise both authenticated transports used by browser-enabled agents.
 * A process-only response or partial SSE handshake is insufficient: each
 * transport must initialize, complete tools/list, and close cleanly.
 */
export async function probePlaywrightMcpTransports(
  port: number,
  capability: string,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<boolean> {
  const query = new URLSearchParams({ owner: PROBE_OWNER });
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerCapability = browserOwnerCapability(capability, PROBE_OWNER);
  const capabilityHeaders = { "X-Browser-Capability": ownerCapability };
  const authenticatedFetch: FetchLike = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("X-Browser-Capability", ownerCapability);
    return fetchImpl(input, { ...init, headers });
  };

  const sseTransport = new SSEClientTransport(new URL(`${baseUrl}/sse?${query}`), {
    fetch: authenticatedFetch,
    eventSourceInit: { fetch: authenticatedFetch },
    requestInit: { headers: capabilityHeaders },
  });
  if (!(await probeMcpTransport(sseTransport))) return false;

  const streamableTransport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp?${query}`),
    {
      fetch: authenticatedFetch,
      requestInit: { headers: capabilityHeaders },
    },
  );
  return probeMcpTransport(streamableTransport, {
    terminate: () => streamableTransport.terminateSession(),
  });
}
