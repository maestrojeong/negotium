export const MERMAID_BROWSER_VERSION = "11.4.1";
export const MERMAID_BROWSER_ASSET_PATH = `/api/v1/assets/mermaid-${MERMAID_BROWSER_VERSION}.min.js`;
export const MERMAID_BROWSER_ASSET_RELATIVE_URL = `../../../../assets/mermaid-${MERMAID_BROWSER_VERSION}.min.js`;

export type MermaidTheme = "default" | "neutral" | "dark" | "forest";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function normalizeMermaidTheme(value: unknown): MermaidTheme {
  return value === "default" || value === "dark" || value === "forest" ? value : "neutral";
}

/** Preserve the selected theme when a stored Mermaid document is rebuilt. */
export function mermaidThemeFromHtml(html: string): MermaidTheme {
  const match = html.match(/\btheme\s*:\s*["'](default|neutral|dark|forest)["']/i);
  return normalizeMermaidTheme(match?.[1]?.toLowerCase());
}

/**
 * Build a self-contained Mermaid viewer. Diagrams retain a readable minimum
 * scale and scroll instead of being squeezed into a narrow side panel; quiet
 * zoom controls remain available for large graphs.
 */
export function buildMermaidHtml(
  code: string,
  theme: MermaidTheme,
  scriptUrl = MERMAID_BROWSER_ASSET_RELATIVE_URL,
): string {
  const safeCode = escapeHtml(code);
  const safeTheme = JSON.stringify(theme);
  const safeScriptUrl = escapeHtml(scriptUrl);
  return `<!doctype html>
<html data-otium-mermaid-version="3">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root{color-scheme:light;--ink:#161614;--ivory:#F6F2EA;--surface:#FFFCF6;--graphite:#2C2D2A;--celadon:#A8BDB2;--border:#DDD7CD}
    *{box-sizing:border-box}
    html,body{margin:0;width:100%;min-height:100%;background:var(--ivory);color:var(--ink);font-family:Geist,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    body{overflow:hidden}
    .viewport{width:100vw;height:100vh;min-height:260px;overflow:auto;padding:58px 24px 24px;scrollbar-gutter:stable}
    .mermaid{display:flex;width:max-content;min-width:100%;justify-content:center;align-items:flex-start}
    .mermaid svg{display:block;max-width:none!important;height:auto!important;flex:none}
    .controls{position:fixed;z-index:2;top:12px;right:12px;display:flex;align-items:center;gap:2px;padding:3px;background:color-mix(in srgb,var(--surface) 94%,transparent);border:1px solid var(--border);border-radius:6px}
    .controls button{height:28px;min-width:30px;padding:0 8px;border:0;border-radius:4px;background:transparent;color:var(--graphite);font:600 12px/1 Geist,system-ui,sans-serif;cursor:pointer}
    .controls button:hover{background:color-mix(in srgb,var(--celadon) 24%,transparent)}
    .controls button:focus-visible{outline:2px solid var(--celadon);outline-offset:1px}
    .zoom-value{min-width:46px;color:var(--graphite);font:500 11px/1 Geist,system-ui,sans-serif;text-align:center;font-variant-numeric:tabular-nums}
    .error{margin:0;white-space:pre-wrap;color:#7D2E2E;background:#FFF5F2;border:1px solid #E4B9B1;border-radius:6px;padding:14px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
    @media(max-width:600px){.viewport{padding:54px 14px 18px}.controls{top:10px;right:10px}}
  </style>
</head>
<body>
  <div class="controls" role="group" aria-label="Diagram zoom">
    <button type="button" data-zoom-out aria-label="Zoom out">−</button>
    <span class="zoom-value" aria-live="polite">100%</span>
    <button type="button" data-zoom-in aria-label="Zoom in">+</button>
    <button type="button" data-zoom-fit aria-label="Fit diagram">Fit</button>
  </div>
  <main class="viewport"><pre class="mermaid">${safeCode}</pre></main>
  <script data-otium-mermaid-runtime src="${safeScriptUrl}"></script>
  <script>
    (async () => {
      try {
      const runtime = globalThis.mermaid;
      if (!runtime) throw new Error("Mermaid renderer failed to load.");
      runtime.initialize({ startOnLoad: false, securityLevel: "strict", theme: ${safeTheme} });
      await runtime.run({ querySelector: ".mermaid" });
      const viewport = document.querySelector(".viewport");
      const svg = document.querySelector(".mermaid svg");
      const value = document.querySelector(".zoom-value");
      const bounds = svg && svg.viewBox && svg.viewBox.baseVal;
      const naturalWidth = Math.max(1, Math.ceil((bounds && bounds.width) || (svg && svg.getBoundingClientRect().width) || 1));
      let scale = Math.max(0.72, Math.min(1, (viewport.clientWidth - 48) / naturalWidth));
      const applyScale = (next, center = true) => {
        const previousWidth = naturalWidth * scale;
        const centerRatio = previousWidth > viewport.clientWidth
          ? (viewport.scrollLeft + viewport.clientWidth / 2) / previousWidth
          : 0.5;
        scale = Math.max(0.5, Math.min(2, next));
        svg.style.width = Math.round(naturalWidth * scale) + "px";
        svg.style.maxWidth = "none";
        svg.style.height = "auto";
        value.textContent = Math.round(scale * 100) + "%";
        if (center) requestAnimationFrame(() => {
          viewport.scrollLeft = Math.max(0, centerRatio * viewport.scrollWidth - viewport.clientWidth / 2);
        });
      };
      document.querySelector("[data-zoom-out]").addEventListener("click", () => applyScale(scale - 0.1));
      document.querySelector("[data-zoom-in]").addEventListener("click", () => applyScale(scale + 0.1));
      document.querySelector("[data-zoom-fit]").addEventListener("click", () => applyScale(Math.min(1, (viewport.clientWidth - 48) / naturalWidth)));
      applyScale(scale, false);
      } catch (error) {
        document.querySelector(".controls")?.remove();
        document.querySelector(".viewport").innerHTML = '<pre class="error">' + String(error && error.message ? error.message : error).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) + '</pre>';
      }
    })();
  </script>
</body>
</html>`;
}
