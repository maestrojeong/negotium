/**
 * Node request-handler plugins.
 *
 * The node's HTTP surface is a chain: plugins → negotium MCP → /health.
 * External integrations (an otium workspace worker, a future peer protocol,
 * custom webhooks) register a handler here BEFORE the host calls startNode;
 * the host mounts every registered handler in registration order. A handler
 * returns `null` to pass the request down the chain.
 *
 * Deliberately tiny: no lifecycle here — plugins own their startup and
 * register cleanup via `onShutdown` like every other subsystem.
 */

export type NodeRequestHandler = (req: Request) => Promise<Response | null> | Response | null;

interface NodePlugin {
  name: string;
  handler: NodeRequestHandler;
}

const plugins: NodePlugin[] = [];

/** Register a request handler ahead of the built-in MCP routes. Idempotent by name (last wins). */
export function registerNodeRequestHandler(name: string, handler: NodeRequestHandler): void {
  const existing = plugins.findIndex((p) => p.name === name);
  if (existing >= 0) plugins.splice(existing, 1);
  plugins.push({ name, handler });
}

export function unregisterNodeRequestHandler(name: string): void {
  const existing = plugins.findIndex((p) => p.name === name);
  if (existing >= 0) plugins.splice(existing, 1);
}

/** Run the plugin chain. Returns the first non-null response, else null. */
export async function runNodeRequestHandlers(req: Request): Promise<Response | null> {
  for (const plugin of plugins) {
    const res = await plugin.handler(req);
    if (res) return res;
  }
  return null;
}

export function nodeRequestHandlerNames(): string[] {
  return plugins.map((p) => p.name);
}
