# Migration to 0.1.40

Version 0.1.40 closes two gaps found while Otium finished converting its ask-user and prompt
forks to the 0.1.39 host-injected factories. No SQLite, topic, conversation, Vault, Wiki, or
browser-profile data migration is required.

## Durable ask-user storage is now public

`negotium/storage` previously omitted the ask-user-gate and runtime-process-lease SQLite storage
that `createAskUserRuntime`'s `host.durability` contract requires, even though the compiled JS
already contained it (the `.d.ts` surface silently dropped it). Embedding hosts that wanted a
durable `ask_user_question` gate without an in-memory fallback had to reimplement that storage
themselves.

- `negotium/storage` now exports the gate operations `prepareAskUserGate`,
  `claimAskUserGateAndSelect`, `cancelAskUserGate`, `quarantineAskUserGate`, and
  `quarantineForeignAskUserGates`, plus their result/record types
  (`PrepareAskUserGateResult`, `ClaimAskUserGateResult`, `AskUserGateCardUpdate`,
  `AskUserGateRecord`), under both direct names and the `askUserGates` namespace.
- `negotium/storage` now exports the runtime-process-lease operations
  `acquireRuntimeProcessLease`, `listRuntimeProcessLeases`, `isRuntimeProcessLeaseAlive`, and
  `removeDeadRuntimeProcessLeases`, plus `RuntimeProcessLease`/`RuntimeProcessLeaseHandle`, under
  both direct names and the `runtimeProcessLeases` namespace.
- `negotium/agent-helpers` now also exports `defaultAskUserDurabilityHost`: the exact
  `host.durability` object Negotium's own default ask-user runtime uses, pre-wired to the SQLite
  gate/lease storage above. Pass it straight into `createAskUserRuntime`:

  ```ts
  import { createAskUserRuntime, defaultAskUserDurabilityHost } from "negotium/agent-helpers";

  createAskUserRuntime({
    messaging, // host-owned publication; persistence must use Negotium's api_messages storage
    topics, // host-owned topic/config lookups
    durability: defaultAskUserDurabilityHost,
    runtime, // host-owned ownerId/createId/now
  });
  ```

  The gate claim step reads and writes the `ask_user_question` column on the real `api_messages`
  row directly, not through `host.messaging.persistence`. A host that reuses
  `defaultAskUserDurabilityHost` must persist the ask-card message via Negotium's
  `appendApiMessage`/`getApiMessage` (also exported from `negotium/storage`) so the gate and the
  message agree on the same row. Hosts that already store messages through Negotium's API-message
  storage (most embedders) get this for free.

## `createPromptBuilders` no longer forces `schedule_self`

`createPromptBuilders` previously always advertised `schedule_self`/`get_self_schedule`/
`update_self_schedule`/`cancel_self_schedule` in the generated runtime-tools prompt section, even
for hosts with no matching delayed-continuation worker. That produced tool-not-found failures when
the model tried to call a tool the host never exposed.

- `PromptBuilderHost` gained a `scheduleSelf?: boolean` option (default `true`, matching Negotium's
  own runtime-server). Hosts without a `schedule_self` implementation should pass
  `createPromptBuilders({ scheduleSelf: false, ... })` to drop that section from every generated
  prompt.

## Fixed: importing `negotium/storage` could eagerly open the fallback database

Making the gate/lease storage above reachable from the public facade surfaced a latent bug:
`runtime-leases.ts`, `runtime-topic-state.ts`, and `runtime-process-leases.ts` ran their `CREATE
TABLE` statements at module load time instead of registering them through
`registerStorageSchemaInitializer`, like every other storage module. That meant merely importing
`negotium/storage` — with no storage operation actually performed — could create the fallback
SQLite file and its containing directories, breaking the documented lazy-resolution contract. All
three modules now register their schema lazily; this is an internal fix with no consumer-facing
API change.

## Package dependencies

Negotium's public packages are released at one version, but consumers only install packages they
directly use. Applications that only embed the runtime should upgrade `negotium` to `0.1.40`.
Add or upgrade `@negotium/adapter-sdk` only when the application implements or imports its public
adapter contracts.

## Upgrade checklist

1. Upgrade direct Negotium dependencies to `0.1.40`.
2. If you built an in-memory or custom durable store for `ask_user_question` gates while waiting
   for this release, replace it with `defaultAskUserDurabilityHost` from `negotium/agent-helpers`,
   keeping message persistence on `appendApiMessage`/`getApiMessage`.
3. If your runtime does not expose `schedule_self` and friends, pass `scheduleSelf: false` to
   `createPromptBuilders` and confirm the generated prompt no longer mentions those tools.
4. Restart the node and exercise an ask-user round trip (question, answer, and a broadcast-failure
   retry) end to end against the new durability wiring.
