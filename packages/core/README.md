# @negotium/core

The local-first Negotium runtime shared by every host and channel adapter. It provides Claude,
Codex, and Maestro providers, durable topics and sessions, a provider-neutral event stream,
wiki/skills, MCP tool definitions, encrypted vault access, and local storage.

```ts
import { registerTopic, runtimeBus, startAiTurn } from "@negotium/core";

const topic = registerTopic({ title: "work", userId: "local", agent: "codex" });
const unsubscribe = runtimeBus().subscribe(console.log);
startAiTurn({
  topic,
  userId: "local",
  prompt: "Review the open tasks.",
  allowAutoContinue: true,
});

// The turn streams in the background. Keep this subscription alive and call
// unsubscribe() only when the embedding host shuts down.
```

The package intentionally ships its Bun-executed TypeScript and runtime resources together so
that built-in stdio MCP servers, prompts, browser launcher, and provider fixtures remain
addressable at runtime. Requires Bun 1.2.15 or newer.
