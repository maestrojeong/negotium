# @negotium/adapter-testkit

Runner-neutral assertions for first- and third-party Negotium adapters. It validates adapter
definitions, handle shape, and idempotent shutdown without coupling packages to a test framework.

```bash
bun add --dev @negotium/adapter-testkit
```

```ts
import {
  assertAdapterStopIsIdempotent,
  assertNegotiumAdapterDefinition,
  assertNegotiumAdapterHandle,
} from "@negotium/adapter-testkit";
import { exampleAdapter } from "./example-adapter";

assertNegotiumAdapterDefinition(exampleAdapter, "example");
const handle = await exampleAdapter.start({ endpoint: "http://127.0.0.1:7777" });
assertNegotiumAdapterHandle(handle, "example");
await assertAdapterStopIsIdempotent(handle);
```

This is a development dependency; runtime hosts only need `@negotium/adapter-sdk`.
