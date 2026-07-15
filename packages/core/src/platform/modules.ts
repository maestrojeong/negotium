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
import { logger } from "#platform/logger";
import { acquireRuntimeProcessLease } from "#storage/runtime-process-leases";

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
  /** Run this module in at most one process sharing the same state database. */
  singleton?: boolean | string;
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
      const moduleCapabilities: string[] = [];
      for (const rawCapability of module.capabilities ?? []) {
        const capability = rawCapability.trim();
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(capability)) {
          throw new Error(`invalid negotium module capability: ${rawCapability}`);
        }
        if (seenCapabilities.has(capability) || moduleCapabilities.includes(capability)) {
          throw new Error(`duplicate negotium module capability: ${capability}`);
        }
        moduleCapabilities.push(capability);
      }
      const singletonRole =
        typeof module.singleton === "string"
          ? module.singleton.trim()
          : module.singleton
            ? `module:${name}`
            : null;
      let moduleHandle: NegotiumNodeModuleHandle | undefined;
      let moduleStopped = false;
      const stopModule = async (): Promise<void> => {
        if (moduleStopped) return;
        moduleStopped = true;
        await moduleHandle?.stop?.();
      };
      const singletonLease = singletonRole
        ? acquireRuntimeProcessLease(singletonRole, {
            onLost: () => {
              logger.error(
                { module: name, role: singletonRole },
                "node module singleton lease lost; stopping module",
              );
              void stopModule().catch((error) =>
                logger.error({ error, module: name }, "node module stop after lease loss failed"),
              );
            },
          })
        : null;
      if (singletonRole && !singletonLease) {
        logger.info({ module: name, role: singletonRole }, "node module owned by another process");
        continue;
      }
      try {
        moduleHandle = module.start(context) ?? {};
        const handle: NegotiumNodeModuleHandle = singletonLease
          ? {
              async stop() {
                try {
                  await stopModule();
                } finally {
                  singletonLease.stop();
                }
              },
            }
          : moduleHandle;
        for (const capability of moduleCapabilities) {
          seenCapabilities.add(capability);
          capabilities.push(capability);
        }
        started.push({ name, handle });
      } catch (error) {
        singletonLease?.stop();
        throw error;
      }
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
