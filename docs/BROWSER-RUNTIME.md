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
      EXAMPLE_BROWSER_VAULT_OWNER: context.ownerId,
    };
  },
  cleanupBrowserProcessesForDataDir(userDataDir) {
    reapManagedBrowserProfile(userDataDir);
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
`ownerId` in the child-environment context is the canonical owner returned by the profile binding,
not necessarily the user that requested the topic.

Configure the host before starting the node so its startup sweep uses the host-managed profile
root. Call `reapPlaywrightOrphans` for an explicit sweep; the manager also uses the same host hook
for its periodic janitor.

## Profile maintenance

Stop a profile and mutate its directory under one lifecycle barrier:

```ts
import {
  withPlaywrightProfileMaintenance,
} from "negotium/browser-runtime";

await withPlaywrightProfileMaintenance(
  ownerId,
  profile,
  async (binding, { stopInstance }) => {
    await stopInstance(binding.instanceKey);
    await deleteProfileDirectory(binding.instanceKey);
  },
);
```

Use `stopPlaywrightProfile(ownerId, profile)` when only a serialized stop is needed.

## Ownership boundary

The host owns:

- topic-to-profile assignment and profile paths;
- product-specific Vault callback variables;
- port range, browser binaries, and proxy configuration;
- crash cleanup and orphan discovery restricted to its managed profile tree.

Negotium owns:

- authenticated SSE and Streamable HTTP MCP handshakes;
- process, port, pin, and restart serialization;
- failure fan-out to active borrowers;
- owner-scoped tab cleanup and capability lifecycle.

`configurePlaywrightManagerHost` rejects reconfiguration while instances or startup operations are
active or borrowed by a turn. Consecutive partial configurations extend the current host; call
`resetPlaywrightManagerHost` to restore Negotium defaults. Returned host objects are frozen. Stop
all managed browsers before changing hosts.
