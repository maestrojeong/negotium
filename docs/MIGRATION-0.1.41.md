# Migration to 0.1.41

Version 0.1.41 fixes a Linux startup regression in the packaged node and the JavaScript export for
the pre-wired durable ask-user host introduced in 0.1.40. No SQLite, topic, conversation, Vault,
Wiki, or browser-profile data migration is required.

## Linux packaged node startup

Version 0.1.40 could enter a CPU-bound initialization loop when `negotium serve` loaded the bundled
node runtime under Bun 1.3.14 on Linux. The bundle contained an async module initialization cycle
between background sessions, topic derivation, and topic sessions. Version 0.1.41 removes that
runtime dependency cycle.

The packed-install release smoke now starts a test-owned canonical daemon and then the production
`negotium serve otium` sidecar path, requiring their `/health` and `/ready` endpoints to become
ready. Owning the daemon process directly also guarantees cleanup when startup fails before daemon
state is published. This verifies long-lived server startup in addition to the existing CLI help,
version, import, and type checks. CI runs this packed startup gate on Ubuntu with Bun 1.3.14, the
environment where the 0.1.40 regression was reproduced.

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
3. Restart the runtime and verify that the node's `/health` endpoint becomes ready.
4. Exercise one durable ask-user round trip.
