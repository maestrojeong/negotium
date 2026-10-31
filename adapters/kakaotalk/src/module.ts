/**
 * `NegotiumNodeModule` wrapper so the kakaotalk adapter can start IN-PROCESS
 * with the canonical node, the same composition point `module-cron` uses
 * (packages/node/src/index.ts `startDefaultNode`).
 *
 * This is deliberately NOT a sidecar-process CLI like adapter-telegram's
 * `cli.ts`. `registerNodeRequestHandler` (the webhook mount) and
 * `registerRuntimeMcpServer` (the `send_kakaotalk` tool) are both in-process
 * registries on `packages/core/src/platform/node-plugins.ts` /
 * `mcp-config.ts` — a separate process talking to the node over HTTP, the
 * way `negotium-telegram` does, could not reach either one. The module must
 * run inside the same process that owns `Bun.serve` and the MCP catalog.
 */

import type { NegotiumNodeModule, NegotiumNodeModuleHandle } from "@negotium/core";
import { type KakaoTalkAdapterOptions, startKakaoTalkAdapter } from "@/adapter";

export function createKakaoTalkModule(options: KakaoTalkAdapterOptions = {}): NegotiumNodeModule {
  return {
    name: "kakaotalk",
    // One instance per shared state database — two would double-register
    // the same node-request-handler name and fight over the manager topic.
    singleton: true,
    capabilities: ["kakaotalk"],
    start(): NegotiumNodeModuleHandle {
      const handle = startKakaoTalkAdapter(options);
      return { stop: () => handle.stop() };
    },
  };
}
