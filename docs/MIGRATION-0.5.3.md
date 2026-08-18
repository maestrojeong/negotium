# Migration 0.5.3 - Maestro Browser.rs Streamable HTTP

`0.5.3` fixes Browser.rs connectivity for Maestro agents, including DeepSeek Pro. No manual data
migration is required.

## Changes

- Maestro browser MCP connections now use authenticated Streamable HTTP at `/mcp` instead of the
  legacy SSE endpoint.
- Browser ownership remains topic-scoped, and the existing `X-Browser-Capability` authentication
  header is sent on every HTTP request.
- Claude continues to use SSE. Codex and Maestro use Streamable HTTP against the same long-lived
  Browser.rs process and browser profile.

## Rollout

Upgrade the `negotium` package to `0.5.3` and restart the node. Existing topics, browser profiles,
and login sessions are preserved.

Upgrade `@negotium/adapter-sdk` to `0.5.3` only in projects that import the public adapter SDK
directly. Its public API is unchanged in this release.
