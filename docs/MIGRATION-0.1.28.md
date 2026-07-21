# Migration to 0.1.28

Version 0.1.28 is a Terminal Vault interaction follow-up to the already published `0.1.27`.
No data migration or configuration change is required.

## Terminal Vault routing

- `/vault` opens a dedicated Vault command screen with stored key names and English examples.
- The old `N`/`D` add and delete shortcuts are removed.
- Add or update a key with `/vault set KEY VALUE | optional description`.
- Delete a key with `/vault del KEY`; the screen stays open and refreshes after each command.
- `/vault list` now lists stored key names without leaving the conversation.
- `/vault manage` is not required or supported.

## Upgrade checklist

1. Upgrade the runtime and adapter SDK together to `0.1.28`.
2. Restart Terminal processes so they load the updated command routing.
