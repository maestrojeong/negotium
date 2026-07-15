/** Stable lifecycle contract implemented by every first-party channel adapter. */

export const NEGOTIUM_ADAPTER_API_VERSION = 3 as const;

export type Awaitable<T> = T | Promise<T>;

export interface NegotiumAdapterHandle<Name extends string = string> {
  /** Stable adapter key used in logs, configuration, and contract tests. */
  readonly name: Name;
  /** Stop accepting channel input and release every owned resource. Idempotent. */
  stop(): Awaitable<void>;
}

/** User-facing transcript semantics; transport gaps stay explicit metadata. */
export interface NegotiumAdapterProjectionCapabilities {
  /** Whether the surface can render a room timeline or only newly delivered events. */
  readonly transcript: "full" | "live-only";
  /** Whether pre-existing topic messages can populate the surface on binding. */
  readonly historyBackfill: boolean;
  /** How authors originating in another adapter are represented. */
  readonly externalAuthors: "native" | "relayed";
}

/** Optional behavioral surfaces are declared independently from lifecycle. */
export interface NegotiumAdapterCapabilities {
  /** Accepts a human message originating on this adapter. */
  readonly localUserInput: boolean;
  /** Exposes create/delete/reset/compact topic commands. */
  readonly topicManagement: boolean;
  /** Executes a turn placed by an external peer runtime. */
  readonly externalPlacedTurn: boolean;
}

export interface NegotiumAdapterDefinition<
  Name extends string,
  Options,
  Handle extends NegotiumAdapterHandle<Name>,
> {
  readonly apiVersion: typeof NEGOTIUM_ADAPTER_API_VERSION;
  readonly name: Name;
  readonly capabilities: NegotiumAdapterCapabilities;
  readonly projection: NegotiumAdapterProjectionCapabilities;
  start(options: Options): Awaitable<Handle>;
}

export function defineNegotiumAdapter<
  const Name extends string,
  Options,
  Handle extends NegotiumAdapterHandle<Name>,
>(
  definition: Omit<NegotiumAdapterDefinition<Name, Options, Handle>, "apiVersion">,
): NegotiumAdapterDefinition<Name, Options, Handle> {
  return { apiVersion: NEGOTIUM_ADAPTER_API_VERSION, ...definition };
}
