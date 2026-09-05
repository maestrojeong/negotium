# Memory-assigned execution defaults

The wiki archiver may decide which model and effort a **memory persona** should run with, and a room
opened later on that persona starts there. This exists for products that do not let a user pick a
model at all: the choice has to come from somewhere, and the only component that has read a
persona's whole history is the archiver.

Owner of the surrounding concepts: [Architecture](./ARCHITECTURE.md) for turn execution and memory,
[Otium coupling](./OTIUM-COUPLING.md) for the create contract.

## The shape of it

```
archiver turn (fixed model, never self-assigns)
  └─ wiki MCP: assign_topic_defaults(model, effort?, reason?)
        └─ topic_default_assignments (keyed by memory key)
              └─ registerTopic({ memoryKey })  →  agent / model / effort
```

Three rules define the whole feature:

1. **Only a model is stored.** The agent backend is derived with `modelOwner(model)`, so no row can
   claim an agent/model pair the registries disagree about, and no caller has to keep the two in
   sync.
2. **The key is the memory persona, not the room.** Rooms are created and deleted constantly; the
   persona is what recurs.
3. **A stored value is a suggestion, never a constraint.** If it no longer validates, it is ignored
   in silence and the node's own defaults apply.

## Why a separate table instead of the topic brief

`api_topic_brief` is rewritten wholesale by `wiki_write(kind="topic")` from a fixed template, so any
extra field would be dropped by the next archive run. More importantly, `deleteTopicCascade` launches
the archiver **fire-and-forget and then deletes the brief**, and when the room being deleted is its
own memory origin the archiver is deliberately given no topic id at all (passing one would let a
detached run recreate an orphan brief row).

`topic_default_assignments` therefore lives on its own, keyed by memory key. Nothing in the room's
lifecycle touches it, so the delete/re-create race disappears without any settlement handshake
between the two — no waiting, no ordering requirement. That is also why the wiki MCP takes
`--memory-key=` separately from `--topic-id=`: the assign tool has to work for a turn whose room is
already gone.

## Priority

```
caller-supplied agent/model/effort   (an explicit decision — always wins)
  → assignment stored for memoryKey  (if present and still valid)
    → node defaults                  (FALLBACK_AGENT / registry model / DEFAULT_TOPIC_EFFORT)
```

An assignment applies only when the caller named **none** of agent, model, or effort — naming any one
of them is a decision the node must not overrule. It also never applies to a `channel` room, since a
channel is deliberately AI-less unless the caller asks otherwise.

`DEFAULT_TOPIC_EFFORT` is one fixed node-wide value (`medium`, override with
`NEGOTIUM_DEFAULT_EFFORT`) rather than each agent's registry default: a model-derived agent switch
would otherwise move effort, and therefore cost, without anyone asking.

## The tool

`assign_topic_defaults(model, effort?, reason?)` is registered **only** when the turn names a memory
persona and the host wired an assignment sink — in practice, only archiver turns. It takes no
`memoryKey` parameter: it uses the persona the archiver actually routed to (the brief it wrote or
adopted this run), falling back to the persona named on the command line. An archiver that reuses an
existing persona instead of the room's title therefore assigns to the persona it chose, not to the
room name.

There is no rate limit. The prompt (`wiki-archiver.md`, step 6) states that the default action is not
to call it and names what does and does not count as evidence. `reason` and `updated_at` are the audit
trail; `assign_count` makes an archiver that keeps re-deciding visible in the data itself.

The archiver's own turn always runs on its prompt-pinned model and never consults assignments, so it
cannot reassign itself.

## Create contract

`POST runtime/v1/topics` accepts an optional `memoryKey` string, advertised as
`canonical-topic-create-memory-key`. Feature-detect it: an older node accepts the body, ignores the
field and answers `201`, so a dropped assignment looks exactly like a successful create. The response
topic echoes the resolved `agent`, `defaultModel`, `defaultEffort`, and `memoryKey`.

The response also carries `defaultsSource: "explicit" | "assigned" | "fallback"` beside `topic`
(`defaults_source` in `register_topic`'s text, `registerTopicDetailed` / `topicService.createDetailed`
in-process). It is reported rather than inferred because `assigned` and `fallback` can produce the
same triple: a host debugging "why is this room on that model" needs to tell "the assignment said so"
from "there was no assignment".

The MCP `register_topic` tool takes the same value as `memory_key`.

Forks and spawned rooms inherit the parent room's stored `defaultModel` / `defaultEffort`, which
already reflect whatever assignment created the parent. They do not re-resolve the assignment, so a
fork keeps running what its parent was running even if the persona has since been reassigned.
Subagent model selection (`spawn_subagent`) is a separate mechanism and is untouched.

## Self-config capability filtering

A product that decides model and effort this way has no use for `set_model` / `set_agent` /
`set_effort`, but the same factory also produces `spawn_topic`, `fork_topic` and the self-schedule
tools, which it still needs. `createSelfConfigRuntime` therefore takes an optional filter:

```ts
createSelfConfigRuntime({
  host,
  capabilities: { exclude: ["set_model", "set_agent", "set_effort"] },
});
```

`include` and `exclude` accept group names (`model`, `agent`, `effort`, `schedules`,
`derived-topics`) and exact tool names, so a host can drop a whole capability or only its mutating
half. `exclude` wins over `include`; omitting the filter keeps every tool the host supports.
