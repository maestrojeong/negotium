#!/usr/bin/env bun

// Keep the unscoped package functional rather than using it as a name-only
// placeholder. The canonical implementation lives in @negotium/cli.
await import("@negotium/cli");

export {};
