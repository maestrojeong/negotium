# Migration 0.12.0

Negotium 0.12.0 makes a threaded turn legible to the model that answers it, and adds two runtime MCP
tools for reading a room's threads on demand.

## Threads are named in the prompt

The canonical store has modelled threads for a long time (`api_messages.thread_root_id`), and the
Runtime Gateway has accepted `threadRootId` on turn submit since 0.3.x. But the thread id was
routing-only: it placed the message rows and never reached the model. Because an agent session is
per topic and chronologically flat, replies from several threads and from the channel arrived as one
undifferentiated stream, and nothing said which lines belonged together.

A user turn that answers a specific message now carries a header naming it:

```
[In thread #a3f1c8 on @AI (claude)]
> 검증 전수 완료. 18개 토픽 응답을 모두 취합했습니다. 결과가 명확합니다.
[@be-seeyong]: 우선 모든 스코프에서 읽히게 하는 것이 우선이니 재키잉 먼저 시도해
```

`#a3f1c8` is the first characters of the root message id — stable across turns, sessions and
processes, so the second reply in a thread can be grouped with the first by reading the session
itself. The existing `[@author]: text` line is unchanged; the header is prepended.

**The thread's earlier replies are deliberately not restated.** They were already sent to this
session as ordinary turns and sit above in the provider's context; re-sending them every turn would
spend tokens to repeat what the model can already read. This is the opposite choice from
`buildMentionOnlyChannelPrompt`, which does re-send a transcript — correctly, because in a
mention-only Channel those messages were never sent to the session at all. That transcript now marks
thread replies as `(in thread #id)` instead of presenting them as channel messages.

The quoted excerpt is read from this Node's own canonical store, never accepted from the host: a host
that could supply the quote could put words in another member's mouth. It is shortened from the
middle, keeping both ends, because a quoted log states its subject first and its outcome last.

## `thread_read` and `thread_list`

Two tools join the per-turn runtime MCP. They read `api_messages` directly — no copy, no cache — and
are scoped to the current topic with no `topicId` parameter, because reading another room is
`session-comm`'s responsibility and it has a permission model for it.

- `thread_read({ thread_id?, limit? })` — one thread in full, oldest first. Called with **no
  arguments** it returns the thread the current turn is answering in. That default is the point: after
  `/compact` or a session reset the tag survives in the visible transcript while the text behind it is
  gone, and that is exactly when the model needs to fetch it. `thread_id` accepts the short `#a3f1c8`
  tag as well as a full root id.
- `thread_list({ limit? })` — the room's threads with tag, reply count and root excerpt, most recently
  active first. This is how a model resolves "the verification thread" when the user names a thread by
  subject rather than by tag.

Output uses the same line format as the channel transcript, so a model does not have to learn two
shapes.

## Threaded turns keep their placement

`ask_user_question` cards raised by a threaded turn, and this turn's system notices, are now stamped
with the thread. An ask card is blocking UI — it only advances when a person clicks it — so a card
that landed in the channel read as a thread that had stalled for no visible reason.

## Quote replies are not thread replies

`POST /turns` also accepts `parentId`, an inline quote-reply pointer at one earlier message of the
room's main flow. It is a separate field from `threadRootId` and the two are mutually exclusive.

The distinction is not cosmetic. `thread_root_id` is membership: the canonical channel listing
excludes every row that carries one. So recording a quote as a thread reply would remove the message
from the conversation it was posted in, while the same action in a host-local room keeps it in the
channel — the same button behaving differently depending on where the room lives. `api_messages`
already had the `parent_id` column for exactly this; only the turn contract was missing it.

A quoted reply therefore renders with its own header and no thread tag:

```
[Replying to @AI (claude)]
> 배포 스크립트를 실행했습니다. bun run deploy … Error: EACCES permission denied on /srv/otium
[@be-seeyong]: 이 로그 원인 좀 봐줘
```

## New capability: `turn-submit-reply-context`

`GET /api/v1/control/runtime/v1/health` advertises `turn-submit-reply-context`, covering both
`threadRootId` and `parentId`. Unlike the other capabilities this one guards against apparent success
rather than an error: a Node without these fields accepts the submission anyway, answering a thread
reply in the channel and dropping a quote, so a host has nothing to catch. Hosts should feature-detect
and refuse or hide the reply affordance rather than offer an action whose answer goes missing.

## Unchanged behavior

- Thread storage, indexes and read routes are unchanged; no database migration is required.
- Merge semantics are unchanged: `mergeRuntimeUserTurnRequest` still folds only requests sharing a
  thread root, and the thread still joins the turn's identity hash.
- Thread replies still do not bump `last_message_at`, and are still excluded from the main message
  list.
- `UserTurnEnvelope` gains an optional `replyTo`; it is persisted inside the existing JSON column, so
  pending requests written by 0.11.x continue to load.
- `parent_id` and `thread_root_id` keep the meanings the schema already gave them; only the turn
  contract gained the ability to set `parent_id`.

## Upgrade notes

Run `bun install`, rebuild Negotium, and restart the resident Node. Hosts that offer a reply or thread
affordance on a Node-backed room should check for `turn-submit-reply-context` in `/health`
capabilities.
