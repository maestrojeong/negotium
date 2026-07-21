# Migration to 0.1.27

Version 0.1.27 improves file delivery and Terminal reliability, and upgrades the Maestro runtime
integration. No data migration or configuration change is required.

## Telegram file delivery

- A standalone Telegram adapter process now installs the canonical node upload resolver.
- Files emitted through `send_file` and `send_files` can therefore be resolved and delivered from
  the node upload store instead of failing after the text response succeeds.

## Terminal Vault commands

- `/vault` and `/vault list` open the interactive Vault manager.
- `/vault set KEY VALUE [description]` stores or updates a secret directly.
- Use `/vault set KEY value with spaces | optional description` when the value contains spaces.
- `/vault del KEY` deletes a secret directly.
- Vault command lines remain excluded from Terminal input history, and transport failures do not
  reflect the plaintext command back into the UI.

## Terminal final-row rendering

- The diff renderer protects writes to the final physical terminal row from pending autowrap.
- Resize redraws no longer address stale rows below the resized screen.
- Terminal shutdown explicitly restores autowrap before leaving the alternate screen.

## Maestro runtime

- `maestro-agent-sdk` is upgraded to 0.1.47 for safer streamed tool arguments, tool-error
  propagation, CRLF SSE parsing, consistent history ordering, and resilient Kimi image handling.

## Upgrade checklist

1. Upgrade the runtime and adapter SDK together to `0.1.27`.
2. Restart standalone Telegram and Terminal processes so they load the new adapter code.
3. If using Maestro, confirm the runtime resolves `maestro-agent-sdk@0.1.47`.
