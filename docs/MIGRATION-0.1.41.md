# Migration to 0.1.41

Version 0.1.41 fixes the packaged JavaScript export for the pre-wired durable ask-user host
introduced in 0.1.40. No SQLite, topic, conversation, Vault, Wiki, or browser-profile data
migration is required.

## `defaultAskUserDurabilityHost` is available at runtime

Version 0.1.40 declared `defaultAskUserDurabilityHost` in the
`negotium/agent-helpers` TypeScript surface, but the package entry point's explicit runtime
re-export list omitted it. Type checking therefore succeeded while this runtime import failed:

```ts
import { defaultAskUserDurabilityHost } from "negotium/agent-helpers";
```

Version 0.1.41 adds the missing JavaScript re-export. The release smoke test now installs the
packed tarball and verifies that both the gate and process-lease operations are present, preventing
future type/runtime export drift.

The storage coupling documented for 0.1.40 is unchanged: the default durability host's gate claim
step uses Negotium's real `api_messages` table. Embedding hosts that reuse it must persist the
ask-card message through Negotium's `appendApiMessage`/`getApiMessage` storage path.

## Upgrade checklist

1. Upgrade direct Negotium dependencies to `0.1.41`.
2. Replace any temporary manual assembly of ask-user gate and process-lease operations with
   `defaultAskUserDurabilityHost` if the host uses Negotium's API-message storage.
3. Restart the runtime and exercise one durable ask-user round trip.

