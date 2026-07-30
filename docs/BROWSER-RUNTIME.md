# Browser runtime

`negotium/browser-runtime` exposes the authenticated Playwright MCP lifecycle without requiring a
consumer to adopt Negotium's profile database or filesystem layout.

Configure the host once during bootstrap, before starting a browser:

```ts
import {
  configurePlaywrightManagerHost,
  ensurePlaywright,
  resolvePlaywrightCapabilityOwner,
} from "negotium/browser-runtime";

configurePlaywrightManagerHost({
  portsDir: "/var/lib/example/browser-ports",
  resolveTopicBinding(userId, topic) {
    const profile = topic ? profileForTopic(topic) : "default";
    const instanceKey = `example:${userId}:${profile}`;
    return {
      instanceKey,
      ownerId: userId,
      profile,
    };
  },
  resolveNamedBinding(ownerId, profile) {
    const instanceKey = `example:${ownerId}:${profile}`;
    return {
      instanceKey,
      ownerId,
      profile,
    };
  },
  resolveInstanceDataDir(instanceKey) {
    return profileDirFromInstanceKey(instanceKey);
  },
  createChildEnvironment(context) {
    return {
      ...context.environment,
      EXAMPLE_BROWSER_VAULT_ENDPOINT: "http://127.0.0.1:3000/vault/browser-transform",
      EXAMPLE_BROWSER_VAULT_TOKEN: context.capability,
    };
  },
  reapOrphanBrowsers(liveUserDataDirs) {
    reapManagedBrowserProfiles(liveUserDataDirs);
  },
});

await ensurePlaywright("user-id", "topic-id");
```

The manager always writes `NEGOTIUM_BROWSER_CAPABILITY` after the child-environment hook returns.
Consumers may reuse that capability for a local Vault callback and resolve its live owner with
`resolvePlaywrightCapabilityOwner`. Do not put browser capabilities in URLs or logs.

## Ownership boundary

The host owns:

- topic-to-profile assignment and profile paths;
- product-specific Vault callback variables;
- port range, browser binaries, and proxy configuration;
- orphan discovery restricted to its managed profile tree.

Negotium owns:

- authenticated SSE and Streamable HTTP MCP handshakes;
- process, port, pin, and restart serialization;
- failure fan-out to active borrowers;
- owner-scoped tab cleanup and capability lifecycle.

`configurePlaywrightManagerHost` rejects reconfiguration while instances or startup operations are
active. Stop all managed browsers before changing hosts.
