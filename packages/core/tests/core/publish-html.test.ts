import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublishHtmlToolDefinitions, parseSnippetId } from "#agents/mcp-tools/publish-html";

/**
 * publish_html rides the same `visualTools` gate as show_html, but unlike the
 * show_* tools it does real work in its handler. These cover the contract the
 * model sees: no backend means no tool at all, local images are embedded, and
 * a reference that would render broken is reported rather than swallowed.
 */
describe("publish_html tool", () => {
  let baseDir: string;
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const requests: { url: string; method: string; body: string }[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), "publish-html-"));
    writeFileSync(join(baseDir, "chart.png"), PNG);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: String(init?.body ?? "") });
      if (method === "DELETE") return Response.json({ ok: true });
      return Response.json({
        ok: true,
        url: "https://snippets.test/snippets/abc-123",
        snippetId: "abc-123",
        expiresAt: "2026-01-01T00:00:00.000Z",
      });
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    rmSync(baseDir, { recursive: true, force: true });
  });

  const tools = (apiUrl = "https://snippets.test") =>
    createPublishHtmlToolDefinitions({ cwd: baseDir }, { apiUrl });
  const publish = () => tools().find((t) => t.name === "publish_html")!;

  test("is omitted entirely when no backend is configured", () => {
    expect(createPublishHtmlToolDefinitions({}, { apiUrl: "" })).toEqual([]);
  });

  test("exposes publish and unpublish when a backend is configured", () => {
    expect(tools().map((t) => t.name)).toEqual(["publish_html", "unpublish_html"]);
  });

  test("returns the public link and embeds local images", async () => {
    requests.length = 0;
    const result = await publish().handler({
      html: '<img src="chart.png">',
    });
    expect(result.isError).toBeUndefined();

    const sent = requests.at(-1)!;
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("https://snippets.test/snippets");
    expect(sent.body).toContain("data:image/png;base64,");
    expect(sent.body).not.toContain("chart.png");

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("https://snippets.test/snippets/abc-123");
    expect(text).toContain("Embedded 1 local file(s)");
  });

  test("warns about a local image that does not exist", async () => {
    const result = await publish().handler({ html: '<img src="missing.png">' });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("WARNING");
    expect(text).toContain("missing.png");
  });

  test("rejects empty html without calling the backend", async () => {
    requests.length = 0;
    const result = await publish().handler({ html: "   " });
    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  });

  test("trailing slashes in the configured base url do not double up", async () => {
    requests.length = 0;
    const [publishTool] = createPublishHtmlToolDefinitions(
      { cwd: baseDir },
      { apiUrl: "https://snippets.test/" },
    );
    await publishTool!.handler({ html: "<p>hi</p>" });
    expect(requests.at(-1)!.url).toBe("https://snippets.test/snippets");
  });

  test("surfaces a backend failure as a tool error", async () => {
    const failing = createPublishHtmlToolDefinitions(
      { cwd: baseDir },
      { apiUrl: "https://snippets.test" },
    )[0]!;
    const saved = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ ok: false, error: "too large" })) as unknown as typeof fetch;
    const result = await failing.handler({ html: "<p>x</p>" });
    globalThis.fetch = saved;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("too large");
  });

  test("unpublish accepts a full url or a bare id", async () => {
    const unpublish = tools().find((t) => t.name === "unpublish_html")!;
    requests.length = 0;
    await unpublish.handler({ snippet: "https://snippets.test/snippets/abc-123" });
    expect(requests.at(-1)!.url).toBe("https://snippets.test/snippets/abc-123");
    await unpublish.handler({ snippet: "abc-123" });
    expect(requests.at(-1)!.url).toBe("https://snippets.test/snippets/abc-123");
  });

  test("unpublish rejects a value with no usable id", async () => {
    const unpublish = tools().find((t) => t.name === "unpublish_html")!;
    const result = await unpublish.handler({ snippet: "../../etc/passwd" });
    expect(result.isError).toBe(true);
  });

  test("parseSnippetId extracts an id and rejects junk", () => {
    expect(parseSnippetId("https://x.test/snippets/aa-bb")).toBe("aa-bb");
    expect(parseSnippetId("aa-bb")).toBe("aa-bb");
    expect(parseSnippetId("../etc/passwd")).toBeNull();
  });
});
