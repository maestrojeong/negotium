import { describe, expect, test } from "bun:test";
import { escapeHtml, markdownToTelegramHtml, renderOutbound, splitMessage } from "@/render";

describe("escapeHtml", () => {
  test("escapes & < > and nothing else", () => {
    expect(escapeHtml(`a & b < c > d "quoted"`)).toBe(`a &amp; b &lt; c &gt; d "quoted"`);
  });
});

describe("markdownToTelegramHtml", () => {
  test("fenced code block with language", () => {
    expect(markdownToTelegramHtml("```ts\nconst a = 1;\n```")).toBe(
      '<pre><code class="language-ts">const a = 1;</code></pre>',
    );
  });

  test("fenced code block without language", () => {
    expect(markdownToTelegramHtml("```\nplain\n```")).toBe("<pre>plain</pre>");
  });

  test("escapes < > & inside code blocks and keeps content verbatim", () => {
    expect(markdownToTelegramHtml("```\nif (a < b && c > d) {}\n```")).toBe(
      "<pre>if (a &lt; b &amp;&amp; c &gt; d) {}</pre>",
    );
  });

  test("code block content is protected from markdown rules", () => {
    expect(markdownToTelegramHtml("```\n**not bold** # not heading\n```")).toBe(
      "<pre>**not bold** # not heading</pre>",
    );
  });

  test("inline code with escaping", () => {
    expect(markdownToTelegramHtml("use `a < b` here")).toBe("use <code>a &lt; b</code> here");
  });

  test("bold, italic, and bold+italic", () => {
    expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
    expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
    expect(markdownToTelegramHtml("***both***")).toBe("<b><i>both</i></b>");
  });

  test("italic does not match inside words", () => {
    expect(markdownToTelegramHtml("file_*name*")).toBe("file_*name*");
  });

  test("strikethrough", () => {
    expect(markdownToTelegramHtml("~~gone~~")).toBe("<s>gone</s>");
  });

  test("links", () => {
    expect(markdownToTelegramHtml("[negotium](https://example.com)")).toBe(
      '<a href="https://example.com">negotium</a>',
    );
  });

  test("headings become bold", () => {
    expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(markdownToTelegramHtml("### Sub")).toBe("<b>Sub</b>");
  });

  test("blockquotes", () => {
    expect(markdownToTelegramHtml("> quoted line")).toBe("<blockquote>quoted line</blockquote>");
  });

  test("escapes < > & in plain text", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });
});

describe("splitMessage", () => {
  test("short text returns a single chunk", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  test("text exactly at the limit stays whole", () => {
    const text = "x".repeat(4096);
    expect(splitMessage(text)).toEqual([text]);
  });

  test("one char over the limit splits in two", () => {
    const text = "x".repeat(4097);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4096);
    expect(chunks[1]).toBe("x");
    expect(chunks.join("")).toBe(text);
  });

  test("prefers a newline boundary in the second half of the window", () => {
    const text = `${"a".repeat(7)}\n${"b".repeat(7)}`;
    const chunks = splitMessage(text, 10);
    expect(chunks).toEqual(["a".repeat(7), "b".repeat(7)]);
  });

  test("ignores a newline too early in the window (before maxLen/2)", () => {
    const text = `ab\n${"c".repeat(20)}`;
    const chunks = splitMessage(text, 10);
    // The only newline sits at index 2 < 10/2, so it hard-splits at maxLen.
    expect(chunks[0]).toHaveLength(10);
    expect(chunks.join("")).toBe(text);
  });

  test("chunks never exceed maxLen and reassemble minus consumed newlines", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n");
    const chunks = splitMessage(text, 40);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40);
    expect(chunks.join("\n")).toBe(text);
  });
});

describe("renderOutbound", () => {
  test("returns one HTML+plain chunk for short text", () => {
    const chunks = renderOutbound("**hi**");
    expect(chunks).toEqual([{ plain: "**hi**", html: "<b>hi</b>" }]);
  });

  test("splits long text and converts each chunk independently", () => {
    const text = `**a**\n${"x".repeat(5000)}`;
    const chunks = renderOutbound(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.html).toContain("<b>a</b>");
    for (const chunk of chunks) expect(chunk.plain.length).toBeLessThanOrEqual(4096);
  });
});
