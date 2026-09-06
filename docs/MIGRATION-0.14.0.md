# Migration 0.14.0

Negotium 0.14.0 lets the wiki archiver choose the model and effort a memory persona runs with, so a
product can drop its model picker entirely. See
[Memory-assigned defaults](./MEMORY-ASSIGNED-DEFAULTS.md) for the full design.

## Breaking behaviour change

**A room created on Claude without an explicit effort now starts at `medium`, not `high`.**

Topic creation used to take the effort from the chosen agent's registry, and those disagree — Claude
`high`, Maestro `medium`, Codex none — so a room's cost depended on which backend the node happened
to default to. There is now one node-wide value, `DEFAULT_TOPIC_EFFORT` (`medium`), which the
registry only overrides when `medium` is invalid for that agent.

Set `NEGOTIUM_DEFAULT_EFFORT=high` to keep the previous Claude behaviour. Existing rooms are
unaffected; their `defaultEffort` is already stored.

## What's new

### `assign_topic_defaults` on the wiki MCP

Registered only for turns that name a memory persona and whose host wired an assignment sink — in
practice only archiver turns. It stores a model (the agent is derived from it with `modelOwner`) plus
an optional effort and reason, keyed by memory persona in the new `topic_default_assignments` table.

The table is created automatically on first start; nothing to migrate. It is deliberately independent
of `api_topic_brief`, so a persona's assignment survives the deletion of every room that used it.

The archiver prompt states that not calling the tool is the default action. `reason`, `updated_at`
and `assign_count` on the row are the audit trail; there is no separate log.

### `memoryKey` on topic creation

`POST runtime/v1/topics` accepts an optional `memoryKey`. When it is given and the caller names
**none** of agent, model, or effort, the room opens on that persona's assigned defaults; any explicit
value still wins, and a `channel` room is never given an agent this way. A stored pairing that no
longer validates is ignored in silence.

New capability flag: **`canonical-topic-create-memory-key`**. Feature-detect it — a node that
predates 0.14.0 accepts the body, ignores the field and still answers `201`, so a dropped assignment
is indistinguishable from a successful create.

The response now carries `defaultsSource: "explicit" | "assigned" | "fallback"` beside `topic`.
In-process, use `registerTopicDetailed()` or `topicService.createDetailed()`; `registerTopic()` keeps
returning a `TopicDto`. The MCP `register_topic` tool takes `memory_key` and prints
`defaults_source`.

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

1. Reinstall the `negotium` package and restart the resident Node. The new table is created on
   startup.
2. If you rely on Claude rooms defaulting to `high` effort, set `NEGOTIUM_DEFAULT_EFFORT=high`.
3. Hosts that want persona-assigned defaults must check for
   `canonical-topic-create-memory-key`, send `memoryKey`, and stop sending `agent`/`model`/`effort`
   on automatic room creation.
