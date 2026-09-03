# Migration 0.12.3

Negotium 0.12.3 puts the *outgoing* side of a threaded `ask_session` in the thread too.

## What was left

0.12.2 placed the answer — the `Reply from …` card and the follow-up turn it triggers — in the thread
the question came from. The question card itself, `Ask to …`, was still written to the channel, so one
exchange was split across two conversations: the request in the channel, its answer in the thread.

`persistVisibleAskMessage` and `notifyCallerTopic` live in the session inbox, beside the delivery code
0.12.2 fixed, and both already had the caller's thread in scope on the entry. They simply did not read
it.

## What changed

- The `Ask to …` card carries the thread the ask was raised from.
- `notifyCallerTopic` takes the thread as well, so an `Error from …` notice — a dropped or invalid ask
  — lands next to the request instead of in the channel.

## Unchanged behavior

- No schema change, no migration, no capability change.
- An ask raised from the channel still records both cards in the channel.
- Inbox entries written before 0.12.1 carry no thread and still answer in the channel.

## Upgrade notes

Run `bun install`, rebuild Negotium, and restart the resident Node.

## Related: card rendering in a thread pane

A host that renders `kind: "tell"` messages as cards has to do so in its thread surface as well.
Otium's channel rendered them through its chat-item classifier while its thread pane printed
`message.text` directly, so a correctly-placed reply card still appeared as raw `[Reply from x]`
markdown. That is a host-side concern, fixed separately in Otium; the canonical message carried its
`tellCard` payload in both cases.
