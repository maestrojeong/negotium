# Feature review guide

Use this checklist to review one Negotium capability at a time. It evaluates the repository against
its own contracts; it is not a parity comparison with another codebase.

Read [Architecture](./ARCHITECTURE.md) first. For channel projection, read
[Adapters](./ADAPTERS.md). For peer compatibility, use [Otium coupling](./OTIUM-COUPLING.md) as the
wire-level authority.

## Review method

For each capability, answer these questions in order:

1. **Authority:** Which process and store own the canonical state?
2. **Ingress:** How do human, background, Cron, and peer inputs enter?
3. **Concurrency:** What happens when work is already active?
4. **Durability:** What is persisted before success, and how is restart recovered?
5. **Egress:** Do messages, tools, files, cards, usage, and terminal outcomes reach the host?
6. **Security:** Which boundary validates user, topic, file, and secret scope?
7. **Lifecycle:** Are partial startup, repeated stop, and forced shutdown safe?
8. **Verification:** Is there a scenario that crosses the real host boundary?

Record one result:

| Result | Meaning |
| --- | --- |
| Preserved | The capability satisfies its documented contract |
| Intentional constraint | A limitation is explicit, owned, and has a visible fallback |
| Gap | Required behavior or end-to-end wiring is missing |
| Out of scope | The responsibility belongs to an adapter, module, or external control plane |

Use this template in an issue or review note:

```text
Result:
Authority:
Failure recovery owner:
Evidence:
Remaining work:
```

## Recommended order

Review foundational capabilities before their consumers:

| Order | Capability | Risk |
| ---: | --- | --- |
| 1 | Topic, message, and configuration authority | High |
| 2 | Turn admission, supersession, abort, and queueing | Critical |
| 3 | RuntimeBus persistence and final delivery | Critical |
| 4 | Provider normalization | Critical |
| 5 | Session resume, model/agent switch, and rollout rebuild | Critical |
| 6 | Tell, ask, and subagent collaboration | High |
| 7 | Ask-user, self-configuration, tasks, and visuals | High |
| 8 | Wiki, skills, vault, and security boundaries | High |
| 9 | MCP catalog and process host | High |
| 10 | Files, attachments, and media | High |
| 11 | Node and module lifecycle | High |
| 12 | Cron scheduling and recovery | High |
| 13 | Terminal adapter | Medium |
| 14 | Telegram adapter | High |
| 15 | Otium adapter | Critical |
| 16 | Private/shared access and transcript projection | Critical |
| 17 | CLI and multi-adapter composition | Medium |
| 18 | Shutdown, recovery, and observability | High |

## Core

### Topics, messages, and configuration

Source:

- `packages/core/src/storage/api-topics.ts`
- `packages/core/src/storage/api-messages.ts`
- `packages/core/src/storage/api-topic-config.ts`
- `packages/core/src/topics/`

Check:

- [ ] Channel and room identifiers exist only in adapter mapping stores.
- [ ] Every read and mutation applies participant and user scope consistently.
- [ ] Hidden internal topics cannot leak into visible topic lists.
- [ ] Delete archives before removing live state and preserves data when archive fails.
- [ ] Rename keeps topic lookup, adapter mappings, and session communication resolvable.
- [ ] Message persistence and bus publication are ordered for reconnect and replay.

Representative tests: `packages/core/tests/storage/api-topics.test.ts`,
`packages/core/tests/core/topic-lifecycle-delete.test.ts`, and
`packages/core/tests/core/topics/derive.test.ts`.

### Turn lifecycle and queues

Source: `runtime/turn-runner.ts`, `query/active-rooms.ts`, `query/control.ts`, and
`runtime/inbox.ts`.

Check:

- [ ] Only human input supersedes an active turn; injections wait.
- [ ] Abort targets the exact query and cannot kill a later replacement.
- [ ] Setup failure, stream failure, abort, and success release the same lock.
- [ ] Each turn emits one terminal outcome and drains deferred work once.
- [ ] Request replay does not create a second provider turn.
- [ ] Silent ask, Cron, and peer turns do not publish unintended user-visible messages.
- [ ] Auto-continue has a bounded loop and cannot bypass human priority.

Representative tests: `packages/core/tests/query/active-rooms.test.ts`,
`inter-session-queue.test.ts`, `smoke.test.ts`, and `stress.test.ts`.

### RuntimeBus and delivery

Source: `packages/core/src/bus.ts`, `storage/runtime-events.ts`, and `storage/api-messages.ts`.

Check:

- [ ] Persisted messages have stable IDs before publication.
- [ ] Final message events precede terminal success.
- [ ] Tool, file, card update, usage, and error events retain topic and query identity.
- [ ] Subscriber failures do not corrupt runtime state or block other subscribers.
- [ ] Reconnect from an event cursor neither skips nor duplicates events.
- [ ] Hosts never reconstruct canonical message state from terminal status alone.

### Providers

Source: `packages/core/src/agents/*-provider.ts`, `*-registry.ts`, and `tool-format.ts`.

Check:

- [ ] Claude, Codex, and Maestro emit the same neutral event meanings.
- [ ] Authentication and quota errors remain distinguishable from transient provider failures.
- [ ] Abort stops the SDK stream and owned subprocesses.
- [ ] Effort and model aliases are validated before provider invocation.
- [ ] Tool calls, results, file changes, usage, and context windows are normalized.
- [ ] Provider logs and errors redact prompts, credentials, and sensitive paths where required.

### Sessions and model switching

Source: `topics/session.ts`, `runtime/topic-config.ts`, provider rollout codecs, and
`application/switch-topic-model.ts`.

Check:

- [ ] Native resume IDs are scoped by topic and provider.
- [ ] Agent/model changes invalidate incompatible native sessions.
- [ ] A neutral-log rebuild preserves role and tool structure without mutating the source rollout.
- [ ] Session-expiry recovery retries at most once.
- [ ] Reset and compaction preserve visible history while changing provider context as documented.
- [ ] Derived topics clone or fork only the state their policy permits.

### Collaboration

Source: `runtime/inbox.ts`, `mcp/session-comm/`, and `agents/mcp-tools/spawn-subagent.ts`.

Check:

- [ ] Inbox append and claim are crash-safe and request IDs deduplicate replay.
- [ ] Tell obeys target-topic admission rules.
- [ ] Ask runs read-only and injects one answer into the caller.
- [ ] Spawn reports one completion and cannot recurse when subagent policy forbids it.
- [ ] Timeout and cancellation clean temporary rollouts, callbacks, and topic state.
- [ ] Local and peer destinations use explicit routing rather than ambiguous title lookup.

### Runtime tools and durable services

Source: `agents/mcp-tools/`, `mcp/task-server.ts`, `mcp/wiki-server.ts`, and
`storage/vault.ts`.

Check:

- [ ] Blocking questions survive until answered, cancelled, or terminated.
- [ ] Self-configuration respects user locks and applies at the documented turn boundary.
- [ ] Tasks remain canonical across provider switches.
- [ ] Visuals have a declared fallback on hosts without a visual surface.
- [ ] Wiki and skill writes are scoped to the node workspace and handle malformed metadata.
- [ ] Vault plaintext never enters normal logs, prompts, or list responses.

### MCP and files

Source: `platform/mcp-config.ts`, `packages/mcp/`, `packages/mcp-host/`,
`runtime/attachments.ts`, and `media/`.

Check:

- [ ] Signed turn context binds runtime tools to one user, topic, and query.
- [ ] MCP process start, health, idle eviction, and shutdown clean port and process state.
- [ ] Provider-specific transports resolve to equivalent tool capabilities.
- [ ] Input files enforce size, path, MIME, and access constraints before provider use.
- [ ] Output files reject traversal, unsafe symlinks, and unauthorized workspace paths.
- [ ] Unsupported media types fail visibly at the responsible adapter boundary.

## Node and modules

### Lifecycle and plugins

Source: `packages/node/src/index.ts`, `platform/lifecycle.ts`, `platform/modules.ts`, and
`platform/node-plugins.ts`.

Check:

- [ ] Partial startup cleans completed steps in reverse order.
- [ ] Capability IDs and request handler names are unique.
- [ ] Repeated `stop()` calls are safe.
- [ ] SIGINT, SIGTERM, API stop, and test teardown use one shutdown registry.
- [ ] The server closes ingress before active turns and children are reaped.
- [ ] Disabled modules create no work or schema side effects.
- [ ] Plugin routes cannot shadow health, MCP, or control endpoints.

### Cron

Source: `packages/module-cron/src/`.

Check:

- [ ] Timezone, DST, day-of-month, and day-of-week behavior is deterministic.
- [ ] Missed schedules coalesce instead of replaying an unbounded backlog.
- [ ] Jobs in one topic serialize and never supersede a human turn.
- [ ] Pending and running rows converge after a crash.
- [ ] Pause, resume, kill, reset, and manual run requests are durable and idempotent.
- [ ] Neutral context is topic-scoped; native resume IDs remain provider-scoped.
- [ ] Rotation cadence and cleanup operate at topic scope.
- [ ] Script paths, runtime, stdout size, and failure output are bounded.

Representative tests: `packages/module-cron/tests/schedule.test.ts`, `scripts.test.ts`, and
`store-scheduler.test.ts`.

## Adapters

Use [Adapters](./ADAPTERS.md) as the behavioral authority rather than restating channel differences
here.

### Terminal

- [ ] Snapshot plus cursor events cannot lose messages at startup.
- [ ] The reducer is deterministic from client-visible data.
- [ ] Unicode width, resize, scroll, and long tool output are bounded.
- [ ] Ask answers and aborts target the active topic and message.
- [ ] Raw mode and alternate screen recover after errors and signals.
- [ ] A client stops only resources it owns.

Representative tests: `adapters/terminal/tests/`.

### Telegram

- [ ] Allowlist behavior is explicit and fail-closed where required.
- [ ] Mapping constraints and startup reconciliation prevent duplicate materialization.
- [ ] Album buffering cannot produce a partial or duplicate turn after restart.
- [ ] HTML splitting preserves tags, entities, and per-chunk plain-text fallback.
- [ ] Retry-after, network backoff, dead-letter, and topic ordering are durable.
- [ ] Unsupported cards and visuals produce a useful fallback.
- [ ] Uploaded output paths and symlinks are safe.

Representative tests: `adapters/telegram/tests/`.

### Otium

- [ ] Protocol fields, headers, status codes, and error bodies match the coupling contract.
- [ ] Peer verification enforces destination, workspace, and primary-node policy.
- [ ] Request replay, conflict, failed retry, and exact abort are deterministic.
- [ ] Event sequences start at one, remain contiguous, and resume without skipping.
- [ ] Final message precedes terminal success.
- [ ] Interrupted requests converge to a hub-visible terminal state after restart.
- [ ] File, remote ask, bridge, and relay gaps fail explicitly until implemented.

Representative tests: `adapters/otium/tests/` and `scripts/otium-experiment/`.

### Topic access and projection

- [x] Local topics default to private.
- [x] Otium peer routes cannot discover private topics.
- [x] Hidden execution mirrors are distinct from user access mode.
- [x] Sharing and returning to private preserve local history.
- [ ] Local-origin messages synchronize to Otium through a durable projection journal.
- [ ] Stable source IDs and binding sequences prevent loops and duplicates.
- [ ] Concurrent human turns from two full adapters follow one supersession rule.
- [ ] Rebind resumes from the last sequence instead of copying all history.
- [ ] Identity and membership mapping exists for Otium-origin rooms projected locally.

## Composition, recovery, and observability

- [ ] One state directory has one node owner and clear diagnostics for conflicts.
- [ ] Several adapters observing one topic do not echo input or duplicate turns.
- [ ] Partial adapter startup unwinds cleanly.
- [ ] Published packages resolve without source aliases or local checkout paths.
- [ ] Forced termination recovers inbox claims, turn requests, peer requests, and Cron runs.
- [ ] Logs distinguish retryable and permanent failure without exposing secrets.
- [ ] Activity logs rotate and delivery failure remains observable separately from turn success.
- [ ] Health reports required worker/module readiness, not process liveness alone.

## Definition of done

A capability review is complete when:

- [ ] authority and recovery ownership are written down;
- [ ] the implementation respects core, module, and adapter boundaries;
- [ ] happy path, abort, replay, retry, and restart behavior are covered as applicable;
- [ ] every supported provider or host-specific constraint is tested;
- [ ] unsupported behavior has a visible fallback;
- [ ] public API and the one owning document are updated; and
- [ ] focused regression tests are listed in the review record.
