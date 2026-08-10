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
    .failure{max-width:56ch;margin:0 auto}
    .failure p{margin:0 0 12px;color:var(--graphite);font:14px/1.6 Geist,system-ui,sans-serif}
    .failure details{color:var(--graphite);font:12px/1.5 Geist,system-ui,sans-serif}
    .failure summary{cursor:pointer;padding:4px 0}
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
      // An unrendered document reports itself in more than one voice: Mermaid's
      // own 0x0 guard, and the browser refusing geometry on a path that was
      // never laid out. Both mean the same thing, so both are worth one retry
      // and, if it still fails, the same explanation.
      const unrendered = (error) => {
        const message = String(error && error.message ? error.message : error);
        return message.indexOf("not in render tree") !== -1 || message.indexOf("path is empty") !== -1;
      };
      try {
      const runtime = globalThis.mermaid;
      if (!runtime) throw new Error("Mermaid renderer failed to load.");
      runtime.initialize({ startOnLoad: false, securityLevel: "strict", theme: ${safeTheme} });
      const host = document.querySelector(".mermaid");
      // Mermaid sizes every label by appending a probe <svg> to the body and
      // reading getBBox(), and it throws "svg element not in render tree" the
      // moment that comes back 0x0. That is what a hidden panel looks like from
      // in here: the document exists but nothing is in the render tree, so the
      // measurement has no geometry to report. Ask the same question Mermaid
      // will ask, and only start once it has an answer.
      const measurable = () => {
        const probe = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.textContent = "M";
        probe.appendChild(text);
        document.body.appendChild(probe);
        let box = { width: 0, height: 0 };
        try { box = text.getBBox(); } catch (ignored) {}
        probe.remove();
        return box.width > 0 || box.height > 0;
      };
      // requestAnimationFrame is the right clock here: a hidden document stops
      // being animated, so this waits without spinning and resumes on the frame
      // the panel is shown. The cap counts rendered frames, not wall time.
      const waitUntilMeasurable = async (maxFrames) => {
        for (let frame = 0; frame < maxFrames; frame += 1) {
          if (measurable()) return true;
          await new Promise((next) => requestAnimationFrame(next));
        }
        return measurable();
      };
      await waitUntilMeasurable(600);
      try {
        await runtime.run({ querySelector: ".mermaid" });
      } catch (firstAttempt) {
        if (!unrendered(firstAttempt)) throw firstAttempt;
        // The panel can be hidden again between the probe and the real measure.
        // Clear the marker Mermaid leaves behind so the retry is not skipped as
        // already done, then wait for the render tree once more.
        host.removeAttribute("data-processed");
        await waitUntilMeasurable(600);
        await runtime.run({ querySelector: ".mermaid" });
      }
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
        const raw = String(error && error.message ? error.message : error);
        const escape = (value) => value.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
        // Mermaid aborts the whole render when it cannot place an edge label:
        // cardinality markers ask for a point a fixed distance along the edge,
        // and a relation laid out shorter than that walks off the end. Nothing
        // is wrong with the diagram, so the raw message sends authors looking
        // for a syntax error that does not exist. Say what actually moves it.
        const note = raw.indexOf("Could not find a suitable point") !== -1
          ? "Two nodes ended up too close together for Mermaid to fit a label on the edge between them. Renaming a node, adding another, or setting an explicit direction usually spreads the layout enough to render."
          : unrendered(error)
          ? "The panel stayed hidden long enough that there was never a laid-out page to measure the diagram against. Reopening the panel renders it."
          : "This diagram could not be rendered.";
        document.querySelector(".viewport").innerHTML =
          '<div class="failure"><p>' + escape(note) +
          '</p><details><summary>Technical detail</summary><pre class="error">' +
          escape(raw) + '</pre></details></div>';
      }
    })();
  </script>
</body>
</html>`;
}
