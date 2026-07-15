# @negotium/adapter-sdk

Versioned lifecycle contract shared by Negotium channel adapters. An API v2 adapter definition has
a stable name, transcript projection capabilities, `start(options)`, and an idempotent `stop()`
handle.

```bash
bun add @negotium/adapter-sdk
```

```ts
import { defineNegotiumAdapter } from "@negotium/adapter-sdk";

export const exampleAdapter = defineNegotiumAdapter({
  name: "example",
  projection: {
    transcript: "full",
    historyBackfill: true,
    externalAuthors: "native",
  },
  start(options: { endpoint: string }) {
    return { name: "example", stop() {} };
  },
});
```

Requires Bun 1.2.15 or newer.
