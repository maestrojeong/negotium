# Migration to 0.1.28

Version 0.1.28 is a Terminal Vault interaction follow-up to the already published `0.1.27`.
No data migration or configuration change is required.

## Terminal Vault routing

- `/vault` continues to open the interactive Vault manager.
- `/vault list` now lists stored key names without leaving the conversation.
- `/vault set KEY VALUE [description]` and `/vault del KEY` remain direct commands.
- `/vault manage` is not required or supported.

## Upgrade checklist

1. Upgrade the runtime and adapter SDK together to `0.1.28`.
2. Restart Terminal processes so they load the updated command routing.
