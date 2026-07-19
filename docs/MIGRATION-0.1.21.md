# Migration to 0.1.21

Version 0.1.21 makes model selection explicit to each running topic, trims the supported picker,
and avoids spending a memory-archiver turn on short reset/delete conversations.

## Model catalog and self-selection

- Every turn now tells the agent its resolved backend, model, and effort.
- The supported picker is grouped into Sonnet-, Opus-, and Fable-level capability bands:
  - Sonnet: `gpt-5.6-luna`, `sonnet`, `deepseek-pro`
  - Opus: `gpt-5.6-terra`, `opus`
  - Fable: `gpt-5.6-sol`, `fable`
- `gpt-5.5`, `deepseek`, and `deepseek-flash` remain recognized for stale-model ownership but are
  no longer offered as selectable models.
- A topic may move directly to the best-fit model within its current backend when the current model
  is clearly insufficient. Backend changes still require an explicit user request, and `fable`
  remains explicit-request-only.
- The system prompt contains one compact capability/cost catalog. Tool schemas reference it instead
  of repeating the full catalog.

## Short-session memory policy

- `/new` and `/del` now mirror the six-completed-exchange threshold used by the Telegram lifecycle.
- Five or fewer completed user/assistant exchanges still produce the raw JSONL archive, but do not
  launch the memory-distillation agent.
- Tool, system, and subagent-card messages do not count as completed exchanges.
- Idle-topic archival keeps its existing independently configurable message threshold.

## Browser launch mode

Negotium now uses `mcp-patchright@0.1.11`, including Patchright 1.61.1 compatibility and virtual
passkey tools. The managed launcher also passes `--headed` explicitly, preserving the existing
visible-browser behavior even if wrapper or upstream defaults change. Agent-facing passkey tools
never expose private-key export controls, and the wrapper strips unexpected private-key material
from passkey results as defense in depth.

## Upgrade checklist

1. Upgrade the runtime and adapter SDK together to `0.1.21`.
2. Restart running Negotium/Otium processes so new topic prompts and picker contents take effect.
3. Confirm any automation that selected `gpt-5.5`, `deepseek`, or `deepseek-flash` uses a supported
   replacement.
