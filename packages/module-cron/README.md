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

Jobs support create, edit, pause/resume, immediate run, cancellation, deletion, durable run history,
exit codes, and topic-shared provider sessions. Editing a job's source, topic, agent, model, or effort
atomically resets stale Cron context. Interrupted runs are finalized on node restart and pending
pre-dispatch runs are recovered.

Prompt labels are generated best-effort when `DEEPSEEK_API_KEY` or
`NEGOTIUM_CRON_SUMMARY_API_KEY` is set. Override the OpenAI-compatible endpoint and model with
`NEGOTIUM_CRON_SUMMARY_URL` and `NEGOTIUM_CRON_SUMMARY_MODEL`.
