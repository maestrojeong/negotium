# Migration 0.13.1

Negotium 0.13.1 bumps the pinned Browser.rs release from v0.3.0 to v0.3.1.

## What changed

- `BROWSER_RS_VERSION` and the `install-browser-rs.mjs` postinstall downloader now target
  [browser-rs-mcp v0.3.1](https://github.com/maestrojeong/browser-rs-mcp/releases/tag/v0.3.1), with
  its verified macOS arm64 and Linux x64 sha256 checksums.
- v0.3.1 fixes a macOS native `<select>` / `<input type="file">` click that could hang for 300
  seconds, and corrects type-ahead label matching for non-Latin text (e.g. Korean).

## Unchanged behavior

- No schema change, no capability change, no new environment variables.
- `BROWSER_RS_MIN_SECURE_VERSION` stays at `0.2.1`.

## Upgrade notes

Run `bun install` (or reinstall the `negotium` package) so the postinstall hook downloads the pinned
v0.3.1 binary, then restart the resident Node.
