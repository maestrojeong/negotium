import {
  NEGOTIUM_ADAPTER_API_VERSION,
  type NegotiumAdapterCapabilities,
  type NegotiumAdapterDefinition,
  type NegotiumAdapterHandle,
} from "./index";

export function assertNegotiumAdapterDefinition<Name extends string>(
  value: unknown,
  expectedName: Name,
): asserts value is NegotiumAdapterDefinition<Name, unknown, NegotiumAdapterHandle<Name>> {
  if (!value || typeof value !== "object") {
    throw new TypeError(`adapter ${expectedName} did not export a definition`);
  }
  const candidate = value as {
    apiVersion?: unknown;
    name?: unknown;
    capabilities?: unknown;
    projection?: unknown;
    start?: unknown;
  };
  if (candidate.apiVersion !== NEGOTIUM_ADAPTER_API_VERSION) {
    throw new TypeError(`adapter ${expectedName} has an incompatible API version`);
  }
  if (candidate.name !== expectedName || typeof candidate.start !== "function") {
    throw new TypeError(`adapter definition must expose name=${expectedName} and start()`);
  }
  const projection = candidate.projection as Record<string, unknown> | undefined;
  if (
    !projection ||
    (projection.transcript !== "full" && projection.transcript !== "live-only") ||
    typeof projection.historyBackfill !== "boolean" ||
    (projection.externalAuthors !== "native" && projection.externalAuthors !== "relayed")
  ) {
    throw new TypeError(`adapter ${expectedName} must declare transcript projection capabilities`);
  }
  const capabilities = candidate.capabilities as Record<string, unknown> | undefined;
  if (
    !capabilities ||
    typeof capabilities.localUserInput !== "boolean" ||
    typeof capabilities.topicManagement !== "boolean" ||
    typeof capabilities.externalPlacedTurn !== "boolean"
  ) {
    throw new TypeError(`adapter ${expectedName} must declare behavioral capabilities`);
  }
}

export type NegotiumAdapterCapability = "localUserInput" | "topicManagement" | "externalPlacedTurn";

export function assertNegotiumAdapterCapability(
  definition: NegotiumAdapterDefinition<string, unknown, NegotiumAdapterHandle>,
  capability: NegotiumAdapterCapability,
  expected: boolean,
): void {
  if (definition.capabilities[capability] !== expected) {
    throw new TypeError(
      `adapter ${definition.name} capability ${capability} must be ${String(expected)}`,
    );
  }
}

export function assertNegotiumAdapterHandle<Name extends string>(
  value: unknown,
  expectedName: Name,
): asserts value is NegotiumAdapterHandle<Name> {
  if (!value || typeof value !== "object") {
    throw new TypeError(`adapter ${expectedName} did not return a handle`);
  }
  const candidate = value as { name?: unknown; stop?: unknown };
  if (candidate.name !== expectedName) {
    throw new TypeError(`adapter handle name must be ${expectedName}`);
  }
  if (typeof candidate.stop !== "function") {
    throw new TypeError(`adapter ${expectedName} handle must expose stop()`);
  }
}

export async function assertAdapterStopIsIdempotent(handle: NegotiumAdapterHandle): Promise<void> {
  await handle.stop();
  await handle.stop();
}

export interface NegotiumAdapterContractOptions<
  Name extends string,
  Options,
  Handle extends NegotiumAdapterHandle<Name>,
> {
  name: Name;
  definition: NegotiumAdapterDefinition<Name, Options, Handle>;
  capabilities: NegotiumAdapterCapabilities;
  createHandle?: () => Handle | Promise<Handle>;
}

export async function assertNegotiumAdapterContract<
  Name extends string,
  Options,
  Handle extends NegotiumAdapterHandle<Name>,
>(options: NegotiumAdapterContractOptions<Name, Options, Handle>): Promise<void> {
  assertNegotiumAdapterDefinition(options.definition, options.name);
  for (const capability of ["localUserInput", "topicManagement", "externalPlacedTurn"] as const) {
    assertNegotiumAdapterCapability(
      options.definition,
      capability,
      options.capabilities[capability],
    );
  }
  if (!options.createHandle) return;
  const handle = await options.createHandle();
  assertNegotiumAdapterHandle(handle, options.name);
  await assertAdapterStopIsIdempotent(handle);
}
