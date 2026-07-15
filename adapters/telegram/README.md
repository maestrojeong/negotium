# @negotium/adapter-telegram

Turn a [Negotium](https://github.com/maestrojeong/negotium) node into a Telegram bot.

Single-operator by design: one human owner (one negotium `userId`), no multi-user scoping.

- **DM General**: a private chat opens the owner's personal `General` manager. First contact and
  `/start` show an English setup guide; natural-language topic creation/delegation/abort/deletion uses
  the same manager as Terminal
- **Chat mode**: non-DM chats keep durable topic mappings; `/new`, `/topics`, `/agent claude|codex|maestro`,
  `/fork [name]`, `/spawn [name]`, `/load <topic>`, `/unload`, `/del [name]`
  (`/del!` to force past archive failures), `/abort`
- **Forum-topic mode**: add the bot to a forum supergroup and promote it with **Manage Topics**.
  The group auto-connects without `/connect`; a missed promotion event is recovered on the first
  admin message. Runtime-created topics (including `spawn_subagent` children) materialize as real
  Telegram forum topics, and the selected group persists across restarts
- **Attachments**: photos/documents download into the topic workspace and prompt the agent with
  core's `[Attached file: …]` convention; albums (`media_group_id`) debounce-buffer into ONE
  combined turn; voice notes transcribe via core's local pipeline (or a custom `transcribe`
  hook); produced `[FILE:/abs/path]` outputs are sent back as photo/document (sensitive paths
  blocked)
- **Durable delivery**: markdown → Telegram HTML subset, 4096-char splitting, per-chunk
  plain-text fallback, typing indicator, durable SQLite retry outbox for 429/5xx/network failures,
  optional `footer: true` turn footer

## Usage

The standalone executable starts its own node:

```bash
npm install --global @negotium/cli
TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_USERS=123456 negotium telegram
```

`TELEGRAM_ALLOWED_USERS` is a comma-separated Telegram user-ID allowlist. An empty value allows
everyone who can reach the bot to act as the same local Negotium owner, so set it for any
non-isolated bot.

Telegram and other channels share SQLite state while running as separate processes:

```bash
TELEGRAM_BOT_TOKEN=... negotium start telegram  # one process
negotium start terminal                         # another shell; may be repeated
```

Telegram holds a state-directory singleton lease, so a second Telegram process fails clearly
instead of starting duplicate polling. Its node uses an ephemeral loopback port.

To connect a group, create a supergroup, enable Topics, add the bot, then promote it to
administrator with **Manage Topics** enabled. The bot announces the connection in the group
General and in the owner's DM. `TELEGRAM_FORUM_CHAT_ID` remains an optional operator override;
normal onboarding does not require it.

For the personal `General`, a turn started in Telegram replies only to the DM or forum location
that started it. An assistant response started from Terminal has no Telegram origin, so it is
mirrored to every Telegram DM/forum mapping for that same `General` to keep those views in sync.

`/load <topic name-or-id>` binds the current chat or forum thread to an existing
visible Negotium topic. Telegram can access both private local topics and shared
topics used by Otium. Internal Otium execution mirrors cannot be listed,
loaded, or materialized as forum threads. `/unload` removes only that Telegram
mapping; it never deletes the topic.

Library embedding is also supported:

```ts
import { startTelegramAdapter } from "@negotium/adapter-telegram";
import { startDefaultNode } from "@negotium/node";
import TelegramBot from "node-telegram-bot-api";

const node = await startDefaultNode();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true });
const adapter = startTelegramAdapter({
  client: bot,
  allowedUsers: ["123456"],
  defaultAgent: "claude",
  // Optional fixed-group override. Omit for promotion-based auto-connect.
  forumChatId: Number(process.env.TELEGRAM_FORUM_CHAT_ID) || undefined,
});

// The embedding host owns shutdown for both resources.
const stop = async () => {
  await adapter.stop();
  await bot.stopPolling({ cancel: true });
  await node.stop();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
```

When embedding the library, the host must boot and stop that process's Negotium node as above.
Other channel processes discover the resulting topic and runtime events through the shared state
database; they do not attach to this in-memory adapter instance.

## Development

Within the monorepo:

```bash
bun run --filter @negotium/adapter-telegram check
bun test adapters/telegram # token-free: fake Telegram client, no agent API calls
```

## License

Apache-2.0
