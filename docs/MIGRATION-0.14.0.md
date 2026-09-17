# Migration 0.14.0

Negotium 0.14.0 adds canonical memory identity to topic creation, standardizes the default topic
effort, and lets embedding products filter self-configuration capabilities.

## Breaking behaviour change

**A room created on Claude without an explicit effort now starts at `medium`, not `high`.**

Topic creation used to take the effort from the chosen agent's registry, and those disagree — Claude
`high`, Maestro `medium`, Codex none — so a room's cost depended on which backend the node happened
to default to. There is now one node-wide value, `DEFAULT_TOPIC_EFFORT` (`medium`), which the
registry only overrides when `medium` is invalid for that agent.

Set `NEGOTIUM_DEFAULT_EFFORT=high` to keep the previous Claude behaviour. Existing rooms are
unaffected; their `defaultEffort` is already stored.

## What's new

### `memoryKey` on topic creation

`POST runtime/v1/topics` accepts an optional `memoryKey`, which identifies the wiki memory persona
the room continues. It is persisted on the topic and echoed in the response, but does not choose or
modify the room's agent, model, or effort. Callers must continue sending concrete execution settings
when they do not want the node defaults. The MCP `register_topic` tool accepts the same value as
`memory_key`.

### Self-config capability filter

`createSelfConfigRuntime({ host, capabilities: { include?, exclude? } })` selects which tools the
factory emits. Group names (`model`, `agent`, `effort`, `schedules`, `derived-topics`) and exact tool
names are both accepted, and `exclude` wins over `include`:

```ts
createSelfConfigRuntime({
  host,
  capabilities: { exclude: ["set_model", "set_agent", "set_effort"] },
});
```

Omitting the filter keeps every tool the host supports, so existing embedders are unaffected.

## Upgrade notes

1. Reinstall the `negotium` package and restart the resident Node.
2. If you rely on Claude rooms defaulting to `high` effort, set `NEGOTIUM_DEFAULT_EFFORT=high`.
3. Hosts may send `memoryKey` to preserve persona identity, but must continue resolving and sending
   concrete `agent`, `model`, and `effort` values as needed.
4. Builds that briefly shipped the abandoned assignment prototype may optionally run
   `DROP TABLE IF EXISTS topic_default_assignments` after deploying this version. No topic or Cron
   columns need to be added or removed.
