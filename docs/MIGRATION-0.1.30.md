# Migration to 0.1.30

Version 0.1.30 improves Terminal visibility for agent tools and file changes. No stored topic,
conversation, Vault, or browser-profile data migration is required.

## Tool and file-change timelines

- Claude, Codex, and Maestro use one shared display classifier for simple read-only shell commands.
  Safe file reads appear as `Read`, searches appear as `Search`, and compound or potentially
  mutating commands remain `Bash`.
- Tool failures now retain an explicit error outcome through the runtime bus and Otium event
  backflow instead of relying on output-text parsing.
- Edit, Write, and Delete entries show compact added/removed line counts and Git-style colored
  previews. Tool names remain neutral while additions and removals use distinct colors.
- When an exact preview is unavailable, Edit entries fall back to `~ modified`.

## Codex diff reliability

- Codex native patch records provide exact numbered diff previews when available.
- A filesystem fallback now also computes old/new line numbers, so Edit previews retain line
  numbers when native rollout writes are delayed or unavailable.
- Resumed sessions ignore patch records consumed by prior turns, and repeated edits maintain a
  moving baseline so native and fallback previews cannot merge unrelated changes.

## Terminal workflow

- Wide terminals can show Tasks in a dedicated sidebar; `Ctrl-T` toggles it.
- Long task lists keep active work visible and report hidden overflow.
- Fenced code blocks expose a clickable copy target while `/copy` continues to copy the latest
  assistant response.

## Upgrade checklist

1. Upgrade `negotium` and `@negotium/adapter-sdk` together to `0.1.30`.
2. Restart Negotium and Terminal processes so they load the updated runtime and renderer.
3. Confirm Edit, Write, and Delete previews display numbered `+`/`-` lines in a fresh turn.
