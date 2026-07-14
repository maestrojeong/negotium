# @negotium/adapter-telegram

Turn a [negotium](https://github.com/maestrojeong/negotium) node into a Telegram bot —
the clawgram successor, as a library.

Single-operator by design: one human owner (one negotium `userId`), no multi-user scoping.

- **Chat mode**: one topic per Telegram chat; `/new`, `/topics`, `/agent claude|codex|maestro`,
  `/fork [name]`, `/spawn [name]`, `/load <topic>`, `/unload`, `/del [name]`
  (`/del!` to force past archive failures), `/abort`
- **Forum-topic mode**: runtime-created topics (including `spawn_subagent` children) materialize
  as real Telegram forum topics; mappings persist across restarts
- **Attachments**: photos/documents download into the topic workspace and prompt the agent with
  core's `[Attached file: …]` convention; albums (`media_group_id`) debounce-buffer into ONE
  combined turn; voice notes transcribe via core's local pipeline (or a custom `transcribe`
  hook); produced `[FILE:/abs/path]` outputs are sent back as photo/document (sensitive paths
  blocked)
- Clawgram-ported delivery: markdown → Telegram HTML subset, 4096-char splitting, per-chunk
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

For Telegram and other channels on the same state, start one combined node:

```bash
TELEGRAM_BOT_TOKEN=... negotium start terminal telegram otium
```

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

If this adapter is embedded alone, the host must boot the Negotium node as above. A combined host
should call `startTelegramFromEnv()` after it has started one shared `@negotium/node` instance.

## Development

Within the monorepo:

```bash
bun run --filter @negotium/adapter-telegram check
bun test adapters/telegram # token-free: fake Telegram client, no agent API calls
```

## License

Apache-2.0
