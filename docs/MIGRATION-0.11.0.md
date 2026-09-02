# Migration 0.11.0

Negotium 0.11.0 gives each AI turn concise context about the product surface that delivered it and
bounds the Wiki persona memory injected into future sessions.

## Surface-aware prompts

The Node now selects an environment profile from the topic's canonical `surface`:

- Terminal turns receive CLI and interactive Terminal context.
- Telegram turns receive direct-chat, group, forum-topic, and mention context.
- Otium turns receive workspace, `surfaceScope`, file-delivery, and visual-capability context.

Node runtime ownership remains in the shared base prompt, while topic, channel, and manager roles stay
independent of the product surface. Custom prompt hosts may receive the additive `surface-profile`
template kind; returning `null` continues to use Negotium's built-in profile.

## Bounded Wiki persona

The Wiki archiver now rewrites a mutable topic profile instead of appending session history to the
persona. Persona content is limited to four non-nested fields and 250 words; the full topic brief is
limited to 800 words. Session summaries are limited to 600 words, while historical implementation
detail remains available through summaries, articles, and query hints.

The archiver prompt and visual-design guide were also shortened, and conflicting Channel, Manager,
and skill guidance was removed.

## Unchanged behavior

- Topic `surface` and `surfaceScope` storage and routing are unchanged.
- Adapter ingress and Runtime Gateway contracts are unchanged.
- Agent, model, effort, tool-capability, and memory selection remain independent of the surface profile.
- No database migration is required.

## Upgrade notes

Run `bun install`, rebuild Negotium, and restart the resident Node. Existing topics use their stored
surface when the Node builds subsequent system prompts.
