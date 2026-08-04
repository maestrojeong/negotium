/**
 * Inline local file references in an HTML document as data URIs.
 *
 * A published snippet is a single file with no asset directory, so a
 * generated document that points at `./chart.png` would render a broken
 * image. Rewriting those references into `data:` URIs keeps the snippet
 * self-contained without giving the store a second lifecycle to manage.
 *
 * Only references that resolve to an existing local file are touched.
 * Remote URLs, `data:`/`blob:` URIs, protocol-relative URLs and fragments
 * are left exactly as written.
 *
 * The scanner is regex-based rather than a full HTML parse. That is a
 * deliberate tradeoff for machine-generated documents: it handles the
 * attribute shapes models actually emit, and anything it fails to match is
 * simply left alone rather than corrupted.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface InlineOptions {
  /** Directory that relative references resolve against. */
  baseDir: string;
  /** Skip any single asset larger than this. */
  maxAssetBytes: number;
  /** Stop inlining once the document would exceed this. */
  maxTotalBytes: number;
}

export interface InlineReport {
  html: string;
  inlined: { ref: string; bytes: number }[];
  /** Looked like a local file but nothing was there — likely a broken image. */
  unresolved: string[];
  /** Existed but was left as-is; the document would have grown too large. */
  skipped: { ref: string; bytes: number; reason: "asset-too-large" | "document-too-large" }[];
}

/** Remote URL, data/blob URI, protocol-relative URL, or bare fragment. */
function isNonLocal(ref: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref.trim());
}

/** `./chart.png?v=2#frag` → `./chart.png` */
function stripSuffix(ref: string): string {
  return ref.replace(/[?#].*$/, "");
}

export function inlineLocalAssets(html: string, options: InlineOptions): InlineReport {
  const { baseDir, maxAssetBytes, maxTotalBytes } = options;

  const inlined: InlineReport["inlined"] = [];
  const unresolved: string[] = [];
  const skipped: InlineReport["skipped"] = [];

  // Same file referenced twice should only be read (and counted) once.
  const cache = new Map<string, string | null>();
  let budget = maxTotalBytes - Buffer.byteLength(html, "utf-8");

  /** Returns the data URI for a reference, or null to leave it untouched. */
  function toDataUri(rawRef: string): string | null {
    const ref = rawRef.trim();
    if (!ref || isNonLocal(ref)) return null;

    const cached = cache.get(ref);
    if (cached !== undefined) return cached;

    const relPath = stripSuffix(ref);
    if (!relPath) return null;

    const abs = isAbsolute(relPath) ? relPath : resolve(baseDir, relPath);

    let bytes: number;
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        unresolved.push(ref);
        cache.set(ref, null);
        return null;
      }
      bytes = statSync(abs).size;
    } catch {
      unresolved.push(ref);
      cache.set(ref, null);
      return null;
    }

    if (bytes > maxAssetBytes) {
      skipped.push({ ref, bytes, reason: "asset-too-large" });
      cache.set(ref, null);
      return null;
    }

    // base64 costs ~4/3 of the raw bytes; check against the remaining budget
    // before reading so an oversized asset never lands in memory twice.
    const encodedCost = Math.ceil(bytes / 3) * 4;
    if (encodedCost > budget) {
      skipped.push({ ref, bytes, reason: "document-too-large" });
      cache.set(ref, null);
      return null;
    }

    let uri: string;
    try {
      const mime = MIME_BY_EXT[extname(abs).toLowerCase()] ?? "application/octet-stream";
      uri = `data:${mime};base64,${readFileSync(abs).toString("base64")}`;
    } catch {
      unresolved.push(ref);
      cache.set(ref, null);
      return null;
    }

    budget -= uri.length;
    inlined.push({ ref, bytes });
    cache.set(ref, uri);
    return uri;
  }

  /** `a.png 1x, b.png 2x` — rewrite each candidate, keep its descriptor. */
  function rewriteSrcset(value: string): string {
    return value
      .split(",")
      .map((candidate) => {
        const trimmed = candidate.trim();
        if (!trimmed) return candidate;
        const [url, ...descriptor] = trimmed.split(/\s+/);
        const uri = url ? toDataUri(url) : null;
        if (!uri) return candidate;
        return [uri, ...descriptor].join(" ");
      })
      .join(", ");
  }

  let out = html;

  // src="..." on img/script/source/video/audio/iframe, and poster="..."
  out = out.replace(
    /(\b(?:src|poster)\s*=\s*)(["'])([^"']*)\2/gi,
    (match, prefix: string, quote: string, ref: string) => {
      const uri = toDataUri(ref);
      return uri ? `${prefix}${quote}${uri}${quote}` : match;
    },
  );

  // srcset="a.png 1x, b.png 2x"
  out = out.replace(
    /(\bsrcset\s*=\s*)(["'])([^"']*)\2/gi,
    (match, prefix: string, quote: string, value: string) => {
      const rewritten = rewriteSrcset(value);
      return rewritten === value ? match : `${prefix}${quote}${rewritten}${quote}`;
    },
  );

  // <link href="style.css"> / icons — but never <a href>.
  out = out.replace(/<link\b[^>]*>/gi, (tag) =>
    tag.replace(
      /(\bhref\s*=\s*)(["'])([^"']*)\2/i,
      (match, prefix: string, quote: string, ref: string) => {
        const uri = toDataUri(ref);
        return uri ? `${prefix}${quote}${uri}${quote}` : match;
      },
    ),
  );

  // CSS url(...) in <style> blocks and style="" attributes.
  out = out.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, quote: string, ref: string) => {
    const uri = toDataUri(ref);
    return uri ? `url(${quote}${uri}${quote})` : match;
  });

  return { html: out, inlined, unresolved, skipped };
}
