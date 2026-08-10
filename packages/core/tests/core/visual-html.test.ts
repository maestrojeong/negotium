import { describe, expect, test } from "bun:test";
import {
  buildMermaidHtml,
  MERMAID_BROWSER_ASSET_PATH,
  MERMAID_BROWSER_VERSION,
  mermaidThemeFromHtml,
  normalizeMermaidTheme,
} from "#runtime/visual-html";

describe("buildMermaidHtml", () => {
  test("keeps the diagram source escaped inside the viewer", () => {
    const html = buildMermaidHtml("graph TD\n  a --> b & <script>", "neutral");

    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<script>a");
  });

  test("pins the renderer and the theme it was built with", () => {
    const html = buildMermaidHtml("graph TD\n  a --> b", "forest");

    expect(html).toContain(`"forest"`);
    expect(mermaidThemeFromHtml(html)).toBe("forest");
    expect(MERMAID_BROWSER_ASSET_PATH).toContain(MERMAID_BROWSER_VERSION);
  });

  // A failed render used to replace the viewport with Mermaid's internal
  // message. For the short-edge abort that reads as a syntax error the author
  // cannot find, because the diagram is in fact well-formed.
  test("explains a failed render instead of only echoing the exception", () => {
    const html = buildMermaidHtml("erDiagram\n  A ||--o{ B : has", "neutral");

    expect(html).toContain("Could not find a suitable point");
    expect(html).toContain("too close together");
    expect(html).toContain("<details>");
    expect(html).toContain("Technical detail");
  });

  // A panel that mounts this document before showing it has no render tree,
  // and Mermaid measures against one. Rendering immediately loses ER diagrams
  // outright, so the viewer waits for a frame it can actually measure.
  test("waits for a render tree before asking Mermaid to measure", () => {
    const html = buildMermaidHtml("erDiagram\n  A ||--o{ B : has", "neutral");

    expect(html).toContain("getBBox");
    expect(html).toContain("requestAnimationFrame");
    expect(html).toContain("waitUntilMeasurable");
  });

  test("retries a render that failed only because nothing was laid out", () => {
    const html = buildMermaidHtml("erDiagram\n  A ||--o{ B : has", "neutral");

    // Both voices of an unrendered document, and the marker that would
    // otherwise make Mermaid skip the second attempt as already done.
    expect(html).toContain("not in render tree");
    expect(html).toContain("path is empty");
    expect(html).toContain("data-processed");
  });

  test("still surfaces the raw failure for anything unrecognized", () => {
    const html = buildMermaidHtml("graph TD\n  a --> b", "neutral");

    expect(html).toContain("This diagram could not be rendered.");
    expect(html).toContain('class="error"');
  });
});

describe("normalizeMermaidTheme", () => {
  test("accepts the supported themes and falls back to neutral", () => {
    expect(normalizeMermaidTheme("dark")).toBe("dark");
    expect(normalizeMermaidTheme("forest")).toBe("forest");
    expect(normalizeMermaidTheme("default")).toBe("default");
    expect(normalizeMermaidTheme("chartreuse")).toBe("neutral");
    expect(normalizeMermaidTheme(undefined)).toBe("neutral");
  });

  test("reads the theme back out of a stored document", () => {
    expect(mermaidThemeFromHtml(buildMermaidHtml("graph TD\n a-->b", "dark"))).toBe("dark");
    expect(mermaidThemeFromHtml("<html></html>")).toBe("neutral");
  });
});
