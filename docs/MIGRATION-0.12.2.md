# Migration 0.12.2

Negotium 0.12.2 makes 0.12.1's fix actually take effect.

## What 0.12.1 missed

0.12.1 taught `session-comm` to record the thread an `ask_session` was raised from, so the answer
could return to that thread instead of the channel. It delivered that value as a `--thread-root-id`
process argument.

`session-comm` is served two ways. The stdio subprocess reads argv — and that is the path 0.12.1
fixed. The default path is a hosted SSE surface on the shared runtime process, which carries its
context in a signed per-turn token (`HostedMcpContext`) and never looks at argv. So on a normal
install the value was written to a channel nobody read, and a threaded ask still answered in the
channel exactly as before.

The tests shipped with 0.12.1 covered the queue behaviour, which was real and correct. They did not
assert that the thread reached the tool, which is where the break was.

## What changed

- `HostedMcpContext` carries `threadRootId`, and `buildBuiltinMcpServer` puts it there.
- `buildHostedSurfaceServer` hands it to the session-comm context as `currentThreadRootId`.
- The hosted server cache identity for `session-comm` includes the thread. Without this a server
  built for a channel turn would be reused for a thread turn in the same room and record the ask
  against the wrong conversation — an intermittent version of the same bug.

A regression test now decodes the hosted spec's token and asserts the thread is in it. Reverting the
builder change makes it fail, which is the property 0.12.1's tests lacked.

## Unchanged behavior

- No schema change, no migration, no capability change.
- The stdio path keeps its `--thread-root-id` argument; both deployments behave the same now.
- Asks already queued by an older process still answer in the channel, as when they were recorded.

## Upgrade notes

Run `bun install`, rebuild Negotium, and restart the resident Node. A restart is required: the MCP
context is minted per turn, but the process that mints it must be running this version.
