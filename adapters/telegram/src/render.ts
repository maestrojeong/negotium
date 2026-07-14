/**
 * Telegram rendering helpers — ported from clawgram's battle-tested
 * `src/telegram/helpers.ts` (pure functions only; no client, retry, or
 * outbox code — the adapter layers delivery policy on top).
 *
 * Telegram supports only a small HTML subset (`<b> <i> <s> <a> <code> <pre>
 * <blockquote>`), so `markdownToTelegramHtml` converts markdown to exactly
 * that subset and escapes everything else. `splitMessage` enforces
 * Telegram's hard 4096-char message limit.
 */

/** Escape HTML entities */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert Markdown to Telegram-compatible HTML.
 * Handles: code blocks, inline code, bold, italic, strikethrough, links, headings, blockquotes.
 */
export function markdownToTelegramHtml(md: string): string {
  // 1. Extract code blocks first to protect their content
  const codeBlocks: string[] = [];
  let text = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    const tag = lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`;
    codeBlocks.push(tag);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${inlineCodes.length - 1}\x00`;
  });

  // 3. Escape HTML in remaining text
  text = escapeHtml(text);

  // 4. Headings → bold (### before ## before #)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // 5. Bold + italic (***text***)
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");

  // 6. Bold (**text**)
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 7. Italic (*text*) — avoid matching inside words like file_*name*
  text = text.replace(/(?<!\w)\*([^\s*](?:.*?[^\s*])?)\*(?!\w)/g, "<i>$1</i>");

  // 8. Strikethrough (~~text~~)
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 9. Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 10. Blockquotes (> lines → <blockquote>)
  text = text.replace(/(?:^&gt; .+\n?)+/gm, (block) => {
    const content = block.replace(/^&gt; /gm, "").trim();
    return `<blockquote>${content}</blockquote>`;
  });

  // 11. Restore inline code
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL sentinel guards escape sequences
  text = text.replace(/\x00INLINE(\d+)\x00/g, (_m, i) => inlineCodes[Number(i)] as string);

  // 12. Restore code blocks
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL sentinel guards escape sequences
  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, i) => codeBlocks[Number(i)] as string);

  return text;
}

/** Split message into chunks of max 4096 chars */
export function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at newline
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    const atNewline = splitAt >= maxLen / 2;
    if (!atNewline) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    // If we split at a newline, skip it so the next chunk doesn't start with \n
    remaining = remaining.slice(atNewline ? splitAt + 1 : splitAt);
  }
  return chunks;
}

/** One deliverable Telegram message: HTML first, plain text as fallback. */
export interface OutboundChunk {
  /** Chunk converted to Telegram HTML — send with `parse_mode: "HTML"`. */
  html: string;
  /** The original plain chunk — resend this when Telegram rejects the HTML. */
  plain: string;
}

/**
 * Render an outbound message the way clawgram's `sendSplitHtmlMsg` does:
 * split the PLAIN text into ≤4096-char chunks first (so the limit is
 * measured on what the plain fallback will actually send), then convert
 * each chunk to Telegram HTML independently. Converting per chunk keeps the
 * HTML fallback per chunk — when a `**bold**` span or code fence is cut
 * mid-chunk and yields HTML Telegram rejects with a 400, only that chunk
 * degrades to plain text instead of the whole message.
 */
export function renderOutbound(text: string, maxLen = 4096): OutboundChunk[] {
  return splitMessage(text, maxLen).map((plain) => ({
    plain,
    html: markdownToTelegramHtml(plain),
  }));
}
