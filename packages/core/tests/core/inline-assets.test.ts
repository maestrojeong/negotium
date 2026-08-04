import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inlineLocalAssets } from "#agents/mcp-tools/inline-assets";

/**
 * A published snippet is one file with no asset directory, so local
 * references have to become data URIs or they render broken. These cover the
 * reference shapes a model actually emits, plus the limits that stop one
 * document from swallowing the store.
 */
describe("snippets: local asset inlining", () => {
  let baseDir: string;
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
  const PNG_B64 = PNG.toString("base64");

  const opts = () => ({
    baseDir,
    maxAssetBytes: 1024 * 1024,
    maxTotalBytes: 10 * 1024 * 1024,
  });

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), "snippet-assets-"));
    writeFileSync(join(baseDir, "chart.png"), PNG);
    writeFileSync(join(baseDir, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(baseDir, "theme.css"), "body{color:red}");
    mkdirSync(join(baseDir, "img"), { recursive: true });
    writeFileSync(join(baseDir, "img", "deep.png"), PNG);
  });

  afterAll(() => rmSync(baseDir, { recursive: true, force: true }));

  test("inlines a relative img src with the right mime type", () => {
    const r = inlineLocalAssets('<img src="./chart.png">', opts());
    expect(r.html).toBe(`<img src="data:image/png;base64,${PNG_B64}">`);
    expect(r.inlined).toHaveLength(1);
    expect(r.unresolved).toEqual([]);
  });

  test("resolves nested and absolute paths", () => {
    const nested = inlineLocalAssets('<img src="img/deep.png">', opts());
    expect(nested.html).toContain("data:image/png;base64,");

    const absolute = inlineLocalAssets(`<img src="${join(baseDir, "chart.png")}">`, opts());
    expect(absolute.html).toContain("data:image/png;base64,");
  });

  test("leaves remote, data, protocol-relative and fragment refs untouched", () => {
    const html = [
      '<img src="https://example.com/a.png">',
      '<img src="http://example.com/b.png">',
      '<img src="data:image/png;base64,AAAA">',
      '<img src="//cdn.example.com/c.png">',
      '<a href="#section">x</a>',
    ].join("");
    const r = inlineLocalAssets(html, opts());
    expect(r.html).toBe(html);
    expect(r.inlined).toEqual([]);
    expect(r.unresolved).toEqual([]);
  });

  test("never inlines an anchor href, only link href", () => {
    const anchor = inlineLocalAssets('<a href="./theme.css">download</a>', opts());
    expect(anchor.html).toBe('<a href="./theme.css">download</a>');
    expect(anchor.inlined).toEqual([]);

    const link = inlineLocalAssets('<link rel="stylesheet" href="./theme.css">', opts());
    expect(link.html).toContain("data:text/css;base64,");
  });

  test("handles srcset candidates with descriptors", () => {
    const r = inlineLocalAssets('<img srcset="chart.png 1x, img/deep.png 2x">', opts());
    expect(r.html).toContain(`data:image/png;base64,${PNG_B64} 1x`);
    expect(r.html).toContain(`data:image/png;base64,${PNG_B64} 2x`);
    expect(r.inlined).toHaveLength(2);
  });

  test("handles poster and CSS url() in style blocks and attributes", () => {
    const r = inlineLocalAssets(
      '<video poster="chart.png"></video>' +
        "<style>.a{background:url('logo.svg')}</style>" +
        "<div style='background:url(\"chart.png\")'></div>",
      opts(),
    );
    expect(r.html).toContain("data:image/svg+xml;base64,");
    expect(r.html).not.toContain("chart.png");
    expect(r.html).not.toContain("logo.svg");
  });

  test("strips query and hash when resolving but still inlines", () => {
    const r = inlineLocalAssets('<img src="./chart.png?v=2">', opts());
    expect(r.html).toContain("data:image/png;base64,");
    expect(r.inlined).toHaveLength(1);
  });

  test("reports a missing local file instead of silently publishing it broken", () => {
    const r = inlineLocalAssets('<img src="./nope.png">', opts());
    expect(r.html).toBe('<img src="./nope.png">');
    expect(r.unresolved).toEqual(["./nope.png"]);
    expect(r.inlined).toEqual([]);
  });

  test("reads a repeated reference once", () => {
    const r = inlineLocalAssets('<img src="chart.png"><img src="chart.png">', opts());
    expect(r.inlined).toHaveLength(1);
    expect(r.html.match(/data:image\/png/g)).toHaveLength(2);
  });

  test("skips an asset over the per-file limit and says so", () => {
    const r = inlineLocalAssets('<img src="chart.png">', { ...opts(), maxAssetBytes: 5 });
    expect(r.html).toBe('<img src="chart.png">');
    expect(r.skipped[0]).toMatchObject({ reason: "asset-too-large" });
  });

  test("stops inlining once the document budget is exhausted", () => {
    // 21 bytes of markup; the 10-byte png costs 16 bytes base64.
    const html = '<img src="chart.png">';
    expect(Buffer.byteLength(html)).toBe(21);

    const fits = inlineLocalAssets(html, { ...opts(), maxTotalBytes: 40 });
    expect(fits.inlined).toHaveLength(1);
    expect(fits.skipped).toEqual([]);

    const tooTight = inlineLocalAssets(html, { ...opts(), maxTotalBytes: 30 });
    expect(tooTight.skipped[0]).toMatchObject({ reason: "document-too-large" });
    expect(tooTight.inlined).toEqual([]);
    expect(tooTight.html).toBe(html);
  });

  test("unknown extensions fall back to a generic mime type", () => {
    writeFileSync(join(baseDir, "data.bin"), Buffer.from([1, 2, 3]));
    const r = inlineLocalAssets('<img src="data.bin">', opts());
    expect(r.html).toContain("data:application/octet-stream;base64,");
  });

  test("a document with no local refs is returned byte-identical", () => {
    const html = "<!doctype html><html><body><h1>hi</h1><svg><rect/></svg></body></html>";
    expect(inlineLocalAssets(html, opts()).html).toBe(html);
  });
});
