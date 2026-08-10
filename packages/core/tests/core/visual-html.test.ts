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
