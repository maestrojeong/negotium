import {
  NEGOTIUM_ADAPTER_API_VERSION,
  type NegotiumAdapterDefinition,
  type NegotiumAdapterHandle,
} from "@negotium/adapter-sdk";

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

/** Capability-specific contract check; adapters test only surfaces they claim. */
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

/** Assert the common shape without coupling adapter packages to a test runner. */
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

/** Shared lifecycle check: every first-party adapter must tolerate repeated stop calls. */
export async function assertAdapterStopIsIdempotent(handle: NegotiumAdapterHandle): Promise<void> {
  await handle.stop();
  await handle.stop();
}
