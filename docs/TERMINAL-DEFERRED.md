# Terminal adapter — known deferred issues

Issues found during review that are **deliberately left unfixed**, or fixed only as far as
they can be. They are recorded here so a later reader does not mistake them for oversights,
and so that anyone who does pick one up knows why a partial fix is worse than none.

Every one was reproduced with measurements, not inferred.

1. [Emoji presentation (VS16) width](#1-emoji-presentation-vs16-is-measured-one-column-narrow) — deferred
2. [Hyperlink target of a wrapped URL](#2-a-wrapped-url-is-hyperlinked-to-a-truncated-target) — deferred
3. [Selection highlight across an SGR reset](#3-selection-highlight-drops-out-of-inverse-video-across-an-sgr-reset) — deferred, cosmetic
4. [Bracketed-paste isolation](#4-bracketed-paste-cannot-be-fully-isolated-mitigated) — mitigated, residual limit is protocol-level

## 1. Emoji presentation (VS16) is measured one column narrow

`displayWidth` is code-point based: it sums `runeWidth` over each code point and treats
every zero-width code point — combining marks, variation selectors, ZWJ — as 0. A
variation selector therefore cannot widen the character in front of it.

Measured (`adapters/terminal/src/render.ts`, `displayWidth`):

| text | code points | `displayWidth` | cells a terminal actually uses |
| --- | --- | --- | --- |
| `❤️` | `U+2764 U+FE0F` | 1 | 2 in most emoji-presenting terminals |
| `❤` | `U+2764` | 1 | 1 (text presentation) |
| `1️⃣` | `U+0031 U+FE0F U+20E3` | 1 | 2 |
| `😀` | `U+1F600` | 2 | 2 |

`U+FE0F` asks for *emoji presentation*, which is double width; the base code point on its
own is narrow. So a line whose only over-measure is a VS16 emoji can render one column
wider than the renderer believes, and the narrow-terminal overflow invariant ("no row is
ever wider than the reported column count") can be broken by exactly that amount.

### Why this is not fixed piecemeal

Width is not one function. `displayWidth`, `sliceWidth`, `wrapText`, `wrapLineWithCursor`
and the mouse-selection column arithmetic in `selection.ts` all have to agree on how many
cells a piece of text occupies, and the composer's cursor — the anchor a Hangul IME uses
for preedit — is derived from that agreement. Teaching one of them about grapheme clusters
while the others still count code points produces rows that disagree about their own
width, which is precisely the class of bug the narrow-terminal work stabilised.

The fix is therefore all-or-nothing: move every one of those callers to grapheme clusters
in a single change, with the width-invariant suite (`tests/wrap-cursor.test.ts`,
`tests/terminal-width.test.ts`, the per-width row assertions in `tests/render.test.ts`)
extended to cover VS16, keycaps and ZWJ sequences first.

`selection.ts` already attaches zero-width code points to the preceding cell, but that is
a *selection-range* decision only — it deliberately does not touch width measurement.

## 2. A wrapped URL is hyperlinked to a truncated target

`linkifyUrls` (`adapters/terminal/src/render.ts`) runs on the fully composed frame, after
wrapping and fitting. That ordering is intentional: OSC 8 escape bytes are zero-width, and
inserting them before the width calculations would perturb every one of them.

The consequence is that a URL long enough to be folded across rows is no longer a single
match. Only the first fragment is recognised as a URL, and the hyperlink target is built
from that fragment — so clicking it opens a **truncated address**, not the real one. The
remaining fragments are plain text.

### Why this is not fixed piecemeal

Fixing it means carrying the link destination through the wrap step: the renderer would
have to keep, for each output row, the ranges that belong to a link and the full target
they point at, then emit OSC 8 per row from that record. That is a render-pipeline change
(`UiLine` gains link spans, `wrapText`/`wrapLineWithCursor` must preserve them across a
fold, and `stripAnsi` must keep agreeing with the emitted format), not a tweak to
`linkifyUrls`.

Until then the displayed text is always correct and complete — only the clickable target
of a wrapped URL is wrong.

## 3. Selection highlight drops out of inverse video across an SGR reset

`highlightRow` (`adapters/terminal/src/selection.ts`) copies ANSI sequences through
untouched while it tracks its own inverse-video flag. It never *re-applies* inverse after
a sequence that resets terminal style, so a `CSI 0 m` sitting between a base character and
its combining mark ends the highlight one code point early.

Reproduction:

```
highlightScreenSelection("e" + ESC[0m + U+0301 + "x", first cell selected)
→ ESC[7m e ESC[0m ´ ESC[27m x
       ^ inverse starts        ^ accent is drawn outside it
```

The trigger is narrow: an SGR reset has to land *between* a base character and the mark
that decorates it, which the renderer does not produce for ordinary content.

**Not a data-loss bug.** `screenSelectionText` attaches zero-width code points to the
preceding cell, so copying `é` yields `U+0065 U+0301` — the accent reaches the clipboard.
Only the on-screen highlight is misdrawn.

Fixing it properly means making `highlightRow` style-aware: parse the SGR sequences it is
currently copying verbatim, and re-assert inverse video after any reset that falls inside
the selected range. That is a rewrite of the highlight loop, not a patch, and the payoff is
a cosmetic edge case.

## 4. Bracketed paste cannot be fully isolated (mitigated)

A payload containing the bytes `ESC [ 2 0 1 ~` ends the paste as far as any reader is
concerned. Delimiter and content are the same bytes on the wire, so no application-side
parser can tell them apart — this is a limitation of the bracketed-paste protocol itself,
not of `splitBracketedPaste`.

Reproduction: feeding `S + (E + <SGR mouse report> + S) + E` (S = `ESC[200~`,
E = `ESC[201~`) splits into `[paste, keys, paste]`, and the middle segment used to reach
the mouse and key parsers ahead of `sanitizePastedText`.

**Mitigated, not solved.** `TerminalApp.#handleInput` now treats every byte that follows a
completed paste *in the same read burst* as text: it goes through `sanitizePastedText` and
into the composer instead of being dispatched. Injected content can therefore still split
one paste into two, but it cannot fire a click, a Ctrl-chord or an Enter — the user sees
the text and decides.

Residual risk and cost:

- A terminal that does not filter the end marker out of pasted content can still cause a
  single paste to arrive as several composer insertions. The characters are all preserved
  and in order; only the paste-collapse grouping differs. Most current terminals do filter
  it, which is what keeps exposure low.
- A genuine keystroke that arrives in the same chunk as the end of a paste is typed rather
  than executed. Human reaction time makes that essentially unreachable, while the same
  chunk is exactly where injected content lives.

Closing the gap entirely would mean not trusting the protocol at all — for example
requiring an out-of-band length or nonce that terminals do not send. That is not
achievable from inside the adapter.
