#!/usr/bin/env bun

// Silence `maestro-agent-sdk`'s login-PATH bootstrap before the bundle loads.
//
// `#platform/maestro-bootstrap-env` already sets this, and in the source tree
// it works: the module is imported ahead of the SDK, so the flag is in place
// when the SDK evaluates it at module load. The bundle breaks that ordering.
// Bun emits the flag-setting module as a lazy `__esm` initializer while the
// SDK stays an external `import` declaration, and ESM hoists every import
// above the module body — so the SDK always ran first and the CLI printed
// `[debug] env-bootstrap: …` on every invocation.
//
// A statement in `dist/main.js` cannot win that race for the same reason, so
// the flag has to be set in a module that runs before it. Hence this shim:
// a plain statement, then a dynamic import, which is ordered.
process.env.MAESTRO_SDK_SILENT_BOOTSTRAP ??= "1";

// Same reason: must be registered before the bundle imports the Codex SDK.
const { hideCodexSdkWindowOnWindows } = await import("./codex-sdk-window-hide.mjs");
await hideCodexSdkWindowOnWindows();

await import("../dist/main.js");
