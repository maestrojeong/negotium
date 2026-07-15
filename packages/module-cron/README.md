# @negotium/module-cron

Optional persistent scheduler for Negotium nodes. Jobs belong to topics, share the topic's
provider-neutral Cron context, wait behind active human turns, and survive process restarts in
the shared SQLite state.

```bash
bun add @negotium/module-cron
```

```ts
import { createCronModule } from "@negotium/module-cron";

const module = createCronModule();
```

`@negotium/node` enables this module in its reference host. Custom hosts can omit it completely.
Requires Bun 1.2.15 or newer.
