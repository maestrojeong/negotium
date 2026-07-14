/**
 * Optional node modules.
 *
 * The runtime kernel does not discover or import modules. A host explicitly
 * passes the modules it wants when it boots a node, which keeps disabled
 * features at zero runtime cost: no import, timer, listener, table migration,
 * or hot-path dispatch.
 *
 * Module startup is deliberately synchronous. A module may start background
 * async work, but it must return its cleanup handle immediately so a partially
 * started node can always unwind deterministically.
 */

import type { RuntimeBus } from "#bus";

export interface NegotiumNodeModuleContext {
  port: number;
  stateDir: string;
  dataDir: string;
  runDir: string;
  workspaceDir: string;
  bus: RuntimeBus;
}

export interface NegotiumNodeModuleHandle {
  stop?: () => Promise<void> | void;
}

export interface NegotiumNodeModule {
  /** Stable capability name, e.g. `cron` or `otium-peer`. */
  name: string;
  /** Stable wire-facing capabilities advertised by hosts such as Otium. */
  capabilities?: readonly string[];
  // biome-ignore lint/suspicious/noConfusingVoidType: modules without cleanup intentionally return nothing.
  start(context: NegotiumNodeModuleContext): NegotiumNodeModuleHandle | void;
}

export interface StartedNegotiumNodeModules {
  names: readonly string[];
  capabilities: readonly string[];
  stop: () => Promise<void>;
}

/** Start an explicit module set and return one reverse-order cleanup handle. */
export function startNegotiumNodeModules(
  modules: readonly NegotiumNodeModule[],
  context: NegotiumNodeModuleContext,
): StartedNegotiumNodeModules {
  const seen = new Set<string>();
  const seenCapabilities = new Set<string>();
  const capabilities: string[] = [];
  const started: Array<{ name: string; handle: NegotiumNodeModuleHandle }> = [];

  try {
    for (const module of modules) {
      const name = module.name.trim();
      if (!name) throw new Error("negotium module name must not be empty");
      if (seen.has(name)) throw new Error(`duplicate negotium module: ${name}`);
      seen.add(name);
      for (const rawCapability of module.capabilities ?? []) {
        const capability = rawCapability.trim();
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(capability)) {
          throw new Error(`invalid negotium module capability: ${rawCapability}`);
        }
        if (seenCapabilities.has(capability)) {
          throw new Error(`duplicate negotium module capability: ${capability}`);
        }
        seenCapabilities.add(capability);
        capabilities.push(capability);
      }
      started.push({ name, handle: module.start(context) ?? {} });
    }
  } catch (error) {
    // Startup is synchronous, so cleanup can be scheduled without delaying the
    // original error. Every shipped module returns an idempotent stop handle.
    for (const entry of started.reverse()) void entry.handle.stop?.();
    throw error;
  }

  let stopped = false;
  return {
    names: started.map((entry) => entry.name),
    capabilities,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const entry of [...started].reverse()) await entry.handle.stop?.();
    },
  };
}
