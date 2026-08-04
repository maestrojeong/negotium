/**
 * `publish_html` — hand the user a public link to a rendered HTML document.
 *
 * This sits beside `show_html`: both exist to show rendered HTML rather than
 * raw markup, so both are gated by the same `visualTools` capability. They
 * differ only in delivery. `show_html` paints a sandboxed in-app panel, which
 * blocks network requests and cannot be opened outside the app; publishing
 * returns an ordinary URL that survives the turn and can be shared.
 *
 * Requires a snippet backend (`NEGOTIUM_SNIPPETS_API_URL`). The tool is left
 * out of the catalog entirely when none is configured, so a deployment
 * without one never advertises a link it cannot mint.
 */
import { z } from "zod";
import { errorResult, type SharedMcpTool, textResult } from "#agents/mcp-tools/common";
import { inlineLocalAssets } from "#agents/mcp-tools/inline-assets";
import { SNIPPETS_API_URL } from "#platform/config";

const REQUEST_TIMEOUT_MS = 30_000;
/** Keep in step with the snippet service's own body limit. */
export const MAX_PUBLISHED_BYTES = 10 * 1024 * 1024;
export const MAX_PUBLISHED_ASSET_BYTES = 5 * 1024 * 1024;

export interface PublishHtmlContext {
  /** Directory that relative asset paths resolve against (the agent's cwd). */
  cwd?: string;
}

type SnippetResponse = {
  ok: boolean;
  url?: string;
  snippetId?: string;
  expiresAt?: string;
  error?: string;
};

export function formatPublishBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Accept a full snippet URL or a bare id, return the id. */
export function parseSnippetId(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/\/snippets\/([A-Za-z0-9-]+)/)?.[1];
  const id = fromUrl ?? trimmed;
  return /^[A-Za-z0-9-]+$/.test(id) ? id : null;
}

async function snippetRequest(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<SnippetResponse> {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as SnippetResponse | null;
    if (body) return body;
    return { ok: false, error: `snippet service returned ${response.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "snippet service unreachable";
    return { ok: false, error: message };
  }
}

/**
 * Build the publish tools, or `[]` when no snippet backend is configured.
 * `ctx` may be a getter so a long-lived server picks up the current turn's cwd.
 */
export function createPublishHtmlToolDefinitions(
  ctx: PublishHtmlContext | (() => PublishHtmlContext),
  options: { apiUrl?: string } = {},
): SharedMcpTool[] {
  const apiUrl = (options.apiUrl ?? SNIPPETS_API_URL)?.replace(/\/+$/, "");
  if (!apiUrl) return [];
  const getCtx = typeof ctx === "function" ? ctx : () => ctx;

  return [
    {
      name: "publish_html",
      description: [
        "Publish an HTML document and return a public, shareable https link that",
        "stays live for 72 hours. Use this when the user should be able to open,",
        "keep, or send the result — a report, dashboard, or styled table — rather",
        "than only glance at it in the side panel.",
        "Pass a complete standalone document and inline the CSS and JS.",
        "For charts and diagrams prefer inline <svg>: it stays sharp at any zoom",
        "and is far smaller than an image file.",
        "Images may be remote URLs, data: URIs, or paths to local files you",
        "created — local files are embedded automatically, so the page keeps",
        "working after your workspace is gone.",
      ].join(" "),
      schema: {
        html: z
          .string()
          .describe("Complete standalone HTML document to publish. Inline the CSS and JS."),
        base_dir: z
          .string()
          .optional()
          .describe(
            "Directory that relative image paths resolve against. Defaults to the working directory.",
          ),
      },
      async handler(input: { html?: string; base_dir?: string }) {
        const html = input?.html ?? "";
        if (!html.trim()) return errorResult("html is empty — provide an HTML document.");

        const baseDir = input.base_dir?.trim() || getCtx().cwd || process.cwd();
        const report = inlineLocalAssets(html, {
          baseDir,
          maxAssetBytes: MAX_PUBLISHED_ASSET_BYTES,
          maxTotalBytes: MAX_PUBLISHED_BYTES,
        });

        const bytes = Buffer.byteLength(report.html, "utf-8");
        if (bytes > MAX_PUBLISHED_BYTES) {
          return errorResult(
            `Document is ${formatPublishBytes(bytes)} after embedding images, over the ${formatPublishBytes(MAX_PUBLISHED_BYTES)} limit. Use fewer or smaller images, or switch charts to inline <svg>.`,
          );
        }

        const result = await snippetRequest(apiUrl, "/snippets", {
          method: "POST",
          headers: { "content-type": "text/html; charset=utf-8" },
          body: report.html,
        });
        if (!result.ok || !result.url) {
          return errorResult(result.error ?? "Failed to publish.");
        }

        // Surface asset problems here so a broken image is visible now rather
        // than only in the user's browser.
        const notes: string[] = [];
        if (report.inlined.length > 0) {
          const total = report.inlined.reduce((sum, a) => sum + a.bytes, 0);
          notes.push(
            `Embedded ${report.inlined.length} local file(s), ${formatPublishBytes(total)}.`,
          );
        }
        if (report.unresolved.length > 0) {
          notes.push(
            `WARNING — these look like local files but were not found, so they will render broken: ${report.unresolved.join(", ")}. Check the paths (relative to ${baseDir}) and republish.`,
          );
        }
        for (const s of report.skipped) {
          notes.push(
            s.reason === "asset-too-large"
              ? `WARNING — ${s.ref} is ${formatPublishBytes(s.bytes)}, over the ${formatPublishBytes(MAX_PUBLISHED_ASSET_BYTES)} per-file limit, and was left as a broken link.`
              : `WARNING — ${s.ref} was left out because the document hit the ${formatPublishBytes(MAX_PUBLISHED_BYTES)} limit.`,
          );
        }

        const payload = {
          url: result.url,
          snippetId: result.snippetId,
          expiresAt: result.expiresAt,
          sizeBytes: bytes,
          ...(report.inlined.length > 0 ? { embeddedFiles: report.inlined.length } : {}),
        };
        return textResult([JSON.stringify(payload, null, 2), ...notes].join("\n\n"));
      },
    },
    {
      name: "unpublish_html",
      description:
        "Delete a previously published HTML document before its 72-hour expiry. Accepts the URL returned by publish_html, or its id.",
      schema: {
        snippet: z.string().describe("URL returned by publish_html, or the bare id."),
      },
      async handler(input: { snippet?: string }) {
        const id = parseSnippetId(input?.snippet ?? "");
        if (!id) return errorResult("Could not read a published document id from that value.");
        const result = await snippetRequest(apiUrl, `/snippets/${id}`, { method: "DELETE" });
        if (!result.ok) return errorResult(result.error ?? "Failed to delete.");
        return textResult(`Published document ${id} deleted.`);
      },
    },
  ];
}
