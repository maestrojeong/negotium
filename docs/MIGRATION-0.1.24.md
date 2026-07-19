# Migration to 0.1.24

Version 0.1.24 closes browser-output redaction gaps found after the 0.1.23 Vault boundary release.

## Browser output redaction

- `browser_snapshot`, `browser_get_visible_text`, `browser_get_visible_html`, and
  `browser_api_request` now produce their complete result before Vault redaction. The caller's
  explicit limit, or the 100,000-character default, is reapplied only after redaction.
- Structured text results are parsed and redacted before JSON serialization, so escaped values do
  not bypass exact secret matching.
- Values expanded into browser inputs remain in the gateway's redaction corpus even if the Vault
  entry is later rotated or deleted while the browser page still contains the old value.
- Every browser success and error result passes through one fail-closed postprocessor. A redaction
  or serialization failure returns a fixed error instead of the original browser output.

## Upgrade checklist

1. Upgrade the runtime and adapter SDK together to `0.1.24`.
2. Restart every Negotium/Otium node and confirm its daemon reports version `0.1.24`.
3. Run only synthetic browser credentials until snapshot, visible text, visible HTML, and API body
   boundary tests pass on the packed runtime.
4. Review historical transcript or log remediation separately; the upgrade does not rewrite
   existing archives.
