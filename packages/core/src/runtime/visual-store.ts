/** Visual (HTML snippet) storage for the Otium WebView renderer.
 *
 *  Each topic stores up to 10 visuals (newest-first); older ones are pruned.
 *  Each user's active selection is tracked separately so multiple people in
 *  the same topic can be on different visuals independently.
 *
 *  Port of the storage/prompt-context half of otium's `api/routes/visual.ts`;
 *  the REST routes (serve HTML/media, CSP headers, list/select endpoints)
 *  stayed in the host.
 */
import { randomUUID } from "node:crypto";
import { db } from "#storage/forum-db";

const MAX_HISTORY = 10;
const MAX_VISUAL_TITLE_CHARS = 180;
export const VISUAL_MEDIA_URL_PLACEHOLDER = "__NEGOTIUM_VISUAL_MEDIA_URL__";

db.exec(`
  CREATE TABLE IF NOT EXISTS api_topic_visuals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id   TEXT    NOT NULL,
    html       TEXT    NOT NULL,
    title      TEXT,
    created_at INTEGER NOT NULL,
    kind       TEXT    NOT NULL DEFAULT 'html',
    source     TEXT,
    file_id    TEXT,
    mime_type  TEXT,
    media_token TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_api_topic_visuals_topic
    ON api_topic_visuals(topic_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS api_topic_visual_views (
    topic_id  TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    visual_id INTEGER NOT NULL,
    PRIMARY KEY (topic_id, user_id)
  );
`);

for (const statement of [
  "ALTER TABLE api_topic_visuals ADD COLUMN kind TEXT NOT NULL DEFAULT 'html'",
  "ALTER TABLE api_topic_visuals ADD COLUMN source TEXT",
  "ALTER TABLE api_topic_visuals ADD COLUMN file_id TEXT",
  "ALTER TABLE api_topic_visuals ADD COLUMN mime_type TEXT",
  "ALTER TABLE api_topic_visuals ADD COLUMN media_token TEXT",
]) {
  try {
    db.exec(statement);
  } catch {
    // Column already exists.
  }
}

// ── DB helpers ──────────────────────────────────────────────────────────────

export const VISUAL_KINDS = ["html", "mermaid", "image", "video"] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];

type VisualRow = {
  id: number;
  topic_id: string;
  html: string;
  title: string | null;
  created_at: number;
  kind: VisualKind;
  source: string | null;
  file_id: string | null;
  mime_type: string | null;
  media_token: string | null;
};
type VisualListRow = {
  id: number;
  title: string | null;
  created_at: number;
  kind: VisualKind;
  mime_type: string | null;
};

export function normalizeVisualTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > MAX_VISUAL_TITLE_CHARS
    ? `${normalized.slice(0, MAX_VISUAL_TITLE_CHARS).trimEnd()}...`
    : normalized;
}

function normalizeVisualKind(value: unknown): VisualKind {
  return VISUAL_KINDS.includes(value as VisualKind) ? (value as VisualKind) : "html";
}

function insertVisual(input: {
  topicId: string;
  html: string;
  title: string | null;
  kind?: VisualKind;
  source?: string | null;
  fileId?: string | null;
  mimeType?: string | null;
  mediaToken?: string | null;
}): number {
  const result = db
    .query<
      { id: number },
      [
        string,
        string,
        string | null,
        number,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO api_topic_visuals
         (topic_id, html, title, created_at, kind, source, file_id, mime_type, media_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      input.topicId,
      input.html,
      input.title,
      Date.now(),
      input.kind ?? "html",
      input.source ?? null,
      input.fileId ?? null,
      input.mimeType ?? null,
      input.mediaToken ?? null,
    );
  if (!result) throw new Error("Failed to insert visual");
  // Prune: keep only the newest MAX_HISTORY rows per topic.
  db.query(
    `DELETE FROM api_topic_visual_views
     WHERE visual_id IN (
       SELECT id FROM api_topic_visuals
       WHERE topic_id = ? AND id NOT IN (
         SELECT id FROM api_topic_visuals WHERE topic_id = ?
         ORDER BY created_at DESC LIMIT ?
       )
     )`,
  ).run(input.topicId, input.topicId, MAX_HISTORY);
  db.query(
    `DELETE FROM api_topic_visuals
     WHERE topic_id = ? AND id NOT IN (
       SELECT id FROM api_topic_visuals WHERE topic_id = ?
       ORDER BY created_at DESC LIMIT ?
     )`,
  ).run(input.topicId, input.topicId, MAX_HISTORY);
  return result.id;
}

function listVisuals(topicId: string): VisualListRow[] {
  return db
    .query<Omit<VisualListRow, "kind"> & { kind: string | null }, [string]>(
      "SELECT id, title, created_at, kind, mime_type FROM api_topic_visuals WHERE topic_id = ? ORDER BY created_at DESC",
    )
    .all(topicId)
    .map((row) => ({ ...row, kind: normalizeVisualKind(row.kind) }));
}

function getVisualById(id: number): VisualRow | null {
  const row = db
    .query<Omit<VisualRow, "kind"> & { kind: string | null }, [number]>(
      "SELECT * FROM api_topic_visuals WHERE id = ?",
    )
    .get(id);
  return row ? { ...row, kind: normalizeVisualKind(row.kind) } : null;
}

export function topicHasVisualFileId(topicId: string, fileId: string): boolean {
  const row = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM api_topic_visuals WHERE topic_id = ? AND file_id = ? LIMIT 1",
    )
    .get(topicId, fileId);
  return Boolean(row);
}

function getUserActiveVisualId(topicId: string, userId: string): number | null {
  const row = db
    .query<{ visual_id: number }, [string, string]>(
      "SELECT visual_id FROM api_topic_visual_views WHERE topic_id = ? AND user_id = ?",
    )
    .get(topicId, userId);
  return row?.visual_id ?? null;
}

function setUserActiveVisualId(topicId: string, userId: string, visualId: number): void {
  db.query(
    `INSERT INTO api_topic_visual_views (topic_id, user_id, visual_id) VALUES (?, ?, ?)
     ON CONFLICT(topic_id, user_id) DO UPDATE SET visual_id = excluded.visual_id`,
  ).run(topicId, userId, visualId);
}

// ── Public helpers ──────────────────────────────────────────────────────────

// Dark-step token values shared by the two dark selectors below (OS-auto via
// media query, and the explicit data-viz-theme="dark" override). Single source
// so the manual switch can never drift from the auto dark palette.
const VIZ_DARK_TOKENS =
  "--viz-surface:#1a1a1a;--viz-plane:#111111;--viz-text:#f2f2f0;--viz-text-secondary:#b6b8ae;--viz-muted:#8f938a;--viz-grid:#2a2a2a;--viz-axis:#3a3a38;--viz-border:rgba(255,255,255,.12);" +
  "--viz-accent:#98ac83;--viz-accent-strong:#b3c49f;--viz-accent-soft:#2a3320;" +
  "--viz-series-1:#98ac83;--viz-series-2:#9aa08f;--viz-series-3:#b0b4a8;--viz-series-4:#7f8f70;--viz-series-5:#d9dbcf;--viz-series-6:#c9d1bf;" +
  "--viz-seq-100:#2f3a26;--viz-seq-200:#40513b;--viz-seq-300:#556845;--viz-seq-400:#6c7d57;--viz-seq-500:#8a9a74;--viz-seq-600:#a7b499;--viz-seq-700:#c9d1bf;" +
  "--viz-good:#4caf50;--viz-warning:#d9a520;--viz-serious:#d98a5a;--viz-critical:#e06666;";

// Base design tokens injected into every stored HTML visual so charts share one
// clean, near-white look built around the olive accent #40513B, with a selected
// dark-mode step (values chosen for the dark surface, validated for contrast and
// CVD, not an automatic flip). Placed first in <head> so an agent's own styles
// override the reset, while the --viz-* custom properties stay available to
// reference. Values mirror prompts/sessions/visual-design.md; keep them in sync.
//
// Theme resolution: no data-viz-theme attribute → follow the OS
// (prefers-color-scheme); data-viz-theme="light"/"dark" → forced by the in-viz
// switch (see VISUAL_THEME_TOGGLE below).
const VISUAL_BASE_STYLE = `<style id="viz-base">
:root{color-scheme:light dark;
--viz-surface:#ffffff;--viz-plane:#f6f6f4;--viz-text:#141414;--viz-text-secondary:#565b50;--viz-muted:#8a8f84;--viz-grid:#ececea;--viz-axis:#d7d7d2;--viz-border:rgba(20,20,20,.10);
--viz-accent:#40513b;--viz-accent-strong:#2c3826;--viz-accent-soft:#eef1ea;
--viz-series-1:#40513b;--viz-series-2:#8c9187;--viz-series-3:#6b7a5f;--viz-series-4:#b9bcb4;--viz-series-5:#2c3826;--viz-series-6:#a0a89a;
--viz-seq-100:#eef1ea;--viz-seq-200:#d4dcca;--viz-seq-300:#9aab8c;--viz-seq-400:#77896a;--viz-seq-500:#566848;--viz-seq-600:#40513b;--viz-seq-700:#2c3826;
--viz-good:#2e7d32;--viz-warning:#b8860b;--viz-serious:#bf6a3a;--viz-critical:#b23b3b;}
@media (prefers-color-scheme:dark){:root:not([data-viz-theme=light]){${VIZ_DARK_TOKENS}}}
:root[data-viz-theme=dark]{${VIZ_DARK_TOKENS}}
:root[data-viz-theme=light]{color-scheme:light}
:root[data-viz-theme=dark]{color-scheme:dark}
*{box-sizing:border-box}
html{background:var(--viz-surface)}
html,body{margin:0;min-height:100%}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--viz-surface);color:var(--viz-text);-webkit-text-size-adjust:100%}
</style>`;

// Floating light/dark switch rendered inside every HTML visual. One inline
// <script> (CSP already allows 'unsafe-inline' for html visuals) that injects
// its own style, so upgrades and idempotency hinge on a single id. The button
// shows the mode a click switches TO (moon while light, sun while dark) and
// flips the data-viz-theme override consumed by VISUAL_BASE_STYLE above.
// No persistence: sandboxed srcDoc iframes have no reliable localStorage, and
// per-document lifetime matches how visuals are reopened from the store.
const VISUAL_THEME_TOGGLE = `<script id="viz-theme-toggle">
(function(){function init(){if(document.getElementById("viz-theme-toggle-btn"))return;
var s=document.createElement("style");
s.textContent="#viz-theme-toggle-btn{position:fixed;top:10px;right:10px;z-index:2147483647;width:30px;height:30px;border-radius:50%;border:1px solid var(--viz-border);background:var(--viz-plane);font:15px/1 system-ui;display:grid;place-items:center;cursor:pointer;opacity:.5;transition:opacity .15s;padding:0}#viz-theme-toggle-btn:hover{opacity:1}";
document.head.appendChild(s);
var b=document.createElement("button");b.id="viz-theme-toggle-btn";b.type="button";b.setAttribute("aria-label","Toggle color theme");
var mq=window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)"):null;
function effective(){var f=document.documentElement.getAttribute("data-viz-theme");return f==="dark"||f==="light"?f:(mq&&mq.matches?"dark":"light")}
function paint(){var dark=effective()==="dark";b.textContent=dark?"\\u2600\\uFE0F":"\\uD83C\\uDF19";b.title=dark?"Light mode":"Dark mode"}
b.addEventListener("click",function(){document.documentElement.setAttribute("data-viz-theme",effective()==="dark"?"light":"dark");paint()});
if(mq&&mq.addEventListener)mq.addEventListener("change",paint);
paint();document.body.appendChild(b)}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init()})();
</script>`;

/**
 * Bake the base design tokens + theme switch into an agent-provided HTML
 * document so every visual shares one palette/reset regardless of render path
 * (web srcDoc, desktop iframe, and native WebView all serve this stored HTML
 * directly). Inserted at the top of <head> so agent styles win the cascade;
 * the --viz-* variables are only added, never overriding what the agent set.
 * Idempotent AND upgrading: a doc that already carries a baked block gets it
 * swapped for the current version (so legacy stored visuals pick up the theme
 * switch at serve time) instead of stacking a second copy.
 */
export function withVisualBaseStyle(html: string): string {
  const inject = `${VISUAL_BASE_STYLE}${VISUAL_THEME_TOGGLE}`;
  if (html.includes('id="viz-base"')) {
    let out = html.replace(/<style id="viz-base">[\s\S]*?<\/style>/, VISUAL_BASE_STYLE);
    out = out.includes('id="viz-theme-toggle"')
      ? out.replace(/<script id="viz-theme-toggle">[\s\S]*?<\/script>/, VISUAL_THEME_TOGGLE)
      : out.replace(VISUAL_BASE_STYLE, inject);
    return out;
  }
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${inject}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<html(?:\s[^>]*)?>/i, (match) => `${match}<head>${inject}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${inject}</head><body>${html}</body></html>`;
}

/** Persist a new visual and return its id. Called by the show_html tool path. */
export function storeTopicVisual(
  topicId: string,
  html: string,
  title?: string,
  activeUserId?: string,
): number {
  const visualId = insertVisual({
    topicId,
    // Rendered document carries the house style; source stays the agent's own
    // HTML so edit-context feedback isn't padded with our boilerplate.
    html: withVisualBaseStyle(html),
    title: normalizeVisualTitle(title) ?? null,
    kind: "html",
    source: html,
  });
  if (activeUserId) setUserActiveVisualId(topicId, activeUserId, visualId);
  return visualId;
}

export function storeTopicMermaidVisual(
  topicId: string,
  code: string,
  html: string,
  title?: string,
  activeUserId?: string,
): number {
  const visualId = insertVisual({
    topicId,
    html,
    title: normalizeVisualTitle(title) ?? null,
    kind: "mermaid",
    source: code,
  });
  if (activeUserId) setUserActiveVisualId(topicId, activeUserId, visualId);
  return visualId;
}

export function storeTopicMediaVisual(input: {
  topicId: string;
  kind: "image" | "video";
  html: string;
  title?: string;
  fileId: string;
  mimeType: string;
  source?: string;
  activeUserId?: string;
}): number {
  const visualId = insertVisual({
    topicId: input.topicId,
    html: input.html,
    title: normalizeVisualTitle(input.title) ?? null,
    kind: input.kind,
    source: input.source ?? null,
    fileId: input.fileId,
    mimeType: input.mimeType,
    mediaToken: randomUUID(),
  });
  if (input.activeUserId) setUserActiveVisualId(input.topicId, input.activeUserId, visualId);
  return visualId;
}

/** Returns info for the system-prompt visual context section, or null if none. */
export function getActiveVisualForPrompt(
  topicId: string,
  userId: string,
): {
  kind: VisualKind;
  content: string;
  fence: "html" | "mermaid" | "text";
  title: string | null;
  index: number;
  total: number;
} | null {
  const rows = listVisuals(topicId);
  if (rows.length === 0) return null;
  const activeId = getUserActiveVisualId(topicId, userId) ?? rows[0]!.id;
  const idx = rows.findIndex((r) => r.id === activeId);
  const targetId = idx >= 0 ? activeId : rows[0]!.id;
  const row = getVisualById(targetId);
  if (!row) return null;
  const total = rows.length;
  const position = idx >= 0 ? idx + 1 : 1;
  if (row.kind === "mermaid") {
    return {
      kind: row.kind,
      content: row.source ?? row.html,
      fence: "mermaid",
      title: row.title,
      index: position,
      total,
    };
  }
  if (row.kind === "image" || row.kind === "video") {
    return {
      kind: row.kind,
      content: [
        `${row.kind === "image" ? "Image" : "Video"} visual`,
        row.title ? `title: ${row.title}` : null,
        row.file_id ? `file_id: ${row.file_id}` : null,
        row.mime_type ? `mime_type: ${row.mime_type}` : null,
        "Binary media data is omitted from the prompt.",
      ]
        .filter(Boolean)
        .join("\n"),
      fence: "text",
      title: row.title,
      index: position,
      total,
    };
  }
  return {
    kind: row.kind,
    content: row.html,
    fence: "html",
    title: row.title,
    index: position,
    total,
  };
}

/** URL that serves the HTML content for a specific visual id (used by iframe). */
export function topicVisualUrl(topicId: string, vizId: number): string {
  return `/api/v1/topics/${encodeURIComponent(topicId)}/visual/${vizId}/html`;
}

export function topicVisualMediaUrl(topicId: string, vizId: number, token: string): string {
  return `/api/v1/topics/${encodeURIComponent(topicId)}/visual/${vizId}/media?token=${encodeURIComponent(token)}`;
}
