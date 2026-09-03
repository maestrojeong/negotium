# Migration 0.11.2

Negotium 0.11.2 pins the managed Browser.rs engine to v0.3.0.

## Browser.rs v0.3.0

Browser.rs v0.3.0 removes the page-level JavaScript stealth layer entirely. Earlier releases
injected a script that patched `screen.*`, `navigator.permissions.query`, `chrome.runtime`,
`speechSynthesis.getVoices`, `navigator.webdriver`, and WebGL vendor/renderer strings to imitate a
human browser. Because Browser.rs already drives a genuinely-installed Chrome, those imitations were
themselves detectable (a shimmed accessor or a fixed fake value differs from what real Chrome
produces natively). v0.3.0 instead leaves those surfaces untouched and relies only on
`--disable-blink-features=AutomationControlled` at launch, plus grounded statistical models (Fitts's
law duration, minimum-jerk motion, log-normal timing) for pointer/keyboard input. It also carries the
real OS-clipboard copy/paste fix, closed-shadow-root hit-testing (including inside iframes), and the
new `browser_iframe_hover` tool shipped in v0.2.2.

`BROWSER_RS_VERSION` (`packages/core/src/platform/config.ts`) and the installer's pinned asset
checksums (`apps/negotium/install-browser-rs.mjs`) are updated accordingly.

## Unchanged behavior

- `BROWSER_RS_MIN_SECURE_VERSION` stays at `0.2.1` — v0.3.0 satisfies it as before.
- No other adapter, prompt, or memory behavior changes in this release.
- No database migration is required.

## Upgrade notes

Run `bun install`, rebuild Negotium, and restart the resident Node so the managed Browser.rs process
is relaunched from the v0.3.0 binary. If an existing `~/.negotium/binaries/browser-rs/v0.2.1`
directory is present from a prior install, it can be removed once the new version is confirmed
running (`browser-rs --version`).
