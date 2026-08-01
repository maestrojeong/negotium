# Migration to 0.1.46

Version 0.1.46 is a terminal-adapter release. It fixes three long-standing
defects (a frame that overflowed narrow terminals, pastes that leaked control
bytes, and a terminal left un-restored when the session died), makes the
conversation render 7–9× cheaper, and reworks the topic picker around a
type-to-filter. No SQLite schema change is required, and no runtime or adapter
API changed — but several **interactive behaviours** did.

## Keybinding changes

| Action | Before | After |
| --- | --- | --- |
| Previous / next topic | `Ctrl-P` / `Ctrl-N` | **removed** |
| New topic | `n` (or `ㅜ`) | **`Ctrl-N`** |
| Delete topic | `d` / `ㅇ` / `Backspace` / `Delete` | **`Ctrl-D`** |
| Filter the topic list | — | **type any printable character** |
| Clear the filter | — | `Backspace`, or `Esc` while the query is non-empty |

`Ctrl-P` is now unbound. Topic cycling was dropped because it duplicated
`Ctrl-O` and became redundant once the picker could be filtered by typing:
`Ctrl-O`, a few characters, `Enter`.

The single-letter shortcuts had to move: they occupied the very keys you need to
type a query, and `d` deleting a topic while you meant to type `docs…` is not a
recoverable mistake. `Backspace` in the picker now edits the filter instead of
deleting the highlighted topic, which removes a second destructive misfire.

`Shift-Enter` / `Ctrl-Enter` insert a newline on terminals that implement the
kitty keyboard protocol (Ghostty, WezTerm, Kitty, recent iTerm2). `Alt-Enter`
still works everywhere and remains the only newline key on Apple Terminal.

## Colour output

Colour depth is now detected instead of assumed:

| Condition | Depth |
| --- | --- |
| `NEGOTIUM_TUI_COLOR=none\|ansi16\|ansi256\|truecolor` | as specified |
| `NO_COLOR` set to a non-empty value | none |
| `FORCE_COLOR=0..3` | none / 16 / 256 / truecolor |
| `TERM=dumb` | none |
| stdout is not a TTY | none |
| `COLORTERM` contains `truecolor` or `24bit` | truecolor |
| `TERM` contains `256color` | 256 |
| otherwise (TTY) | 16 |

**Piped output is now uncoloured.** `negotium | tee log` and `negotium > out.txt`
no longer contain ANSI sequences. Pass `FORCE_COLOR=3` (or
`NEGOTIUM_TUI_COLOR=truecolor`) to keep them.

When the depth is `none` the adapter also stops changing the terminal background
(`OSC 11`) and stops emitting the restore (`OSC 111`), so your own theme is left
alone.

Notices are now classified — `·` info, `✓` success, `!` warn, `✗` error — so
severity survives with colour switched off. An unclassified notice keeps the
previous amber `!`.

## Terminal restore

The adapter previously restored the terminal only on a clean exit and on
`SIGINT`/`SIGTERM`. **`SIGHUP` — what an SSH disconnect actually delivers — was
not handled**, so a dropped connection left the alternate screen and the
background colour applied. Restore now runs from `exit`, `SIGINT`, `SIGTERM`,
`SIGHUP`, `uncaughtExceptionMonitor` and `unhandledRejection`, writes
synchronously with `writeSync`, retries a short write, and is idempotent.

Two consequences for embedders:

- Only one `TerminalApp` may own the terminal at a time. A second concurrent
  `run()` now throws `TerminalAlreadyOwnedError` instead of silently taking over
  and breaking the first one's input. Stop the first adapter before starting
  another.
- A second identical signal (a second `Ctrl-C` during a wedged shutdown) forces
  `process.exit(128 + signo)` so the user can always escape.

Restore is observation-only for crashes: the host's own `uncaughtException` /
`unhandledRejection` policy is preserved, and the adapter only guarantees that
the terminal is restored *before* any diagnostics are written — otherwise a
stack trace printed onto the alternate screen disappears with it.

`SIGKILL` and power loss remain unrecoverable by construction.

## Rendering

- Frames never exceed the reported terminal width. The old `Math.max(32, cols)`
  floor is gone; below the fold the pane sheds its border, then its title, then
  footer detail, and skips entirely when there is no room at all.
- Wrapping is word-aware, with CJK breaking per character and kinsoku handling
  so a closing bracket or full stop is not orphaned onto the next row.
  Row layout and cursor mapping are now produced by one function, so the
  composer caret and the Hangul preedit anchor cannot drift apart.
- The caret sits at the **start of the next row** at a fold boundary, matching
  where a typed character actually appears.
- Finalized message layout is cached, cutting a runtime event from ~7.9 ms to
  ~0.81 ms at 400 messages.
- Frames are wrapped in synchronized output (DECSET 2026) to stop tearing, and
  bare URLs become OSC 8 hyperlinks.

Conversation line counts will differ from 0.1.45 because of the new wrapping.

## Paste handling

Pasted text is split on bracketed-paste markers before any key or mouse parsing,
so an escape sequence inside the clipboard can no longer be consumed as a real
click. The payload is sanitized on insert: escape sequences are removed,
`\r\n`/`\r` collapse to `\n`, and **tabs become four spaces**.

The tab substitution is deliberate — pasting a spreadsheet selection loses its
column separators. Keeping the tab byte would require teaching every width
calculation about tab stops. See `docs/TERMINAL-DEFERRED.md`.

## Input history

`Up` now searches history by the text **in front of the caret** rather than the
whole draft, so typing `git st` and pressing `Up` finds `git status`. `Down`
restores the original draft, including its caret position. An empty draft still
walks the full history.

## Known deferred issues

`docs/TERMINAL-DEFERRED.md` records four issues that were found during review
and deliberately left as-is, with the measured behaviour, why a partial fix
would be unsafe, and the scope of a real fix. They are not oversights.
