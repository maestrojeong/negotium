import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { workspaceCwdFor } from "#runtime/attachments";
import {
  isUploadFileId,
  resolveAttachmentByFileId,
  resolveUploadedFilePathByFileId,
  storeLocalFileAsUpload,
} from "#runtime/file-hooks";
import { topicHasVisualFileId, VISUAL_MEDIA_URL_PLACEHOLDER } from "#runtime/visual-store";
import { isSensitivePath } from "#security/sensitive-path";
import { topicHasAttachmentFileId } from "#storage/api-messages";

export { buildMermaidHtml, normalizeMermaidTheme } from "#runtime/visual-html";

const ACTIVE_VISUAL_PROMPT_MAX_CHARS = 24_000;
const ACTIVE_VISUAL_PROMPT_TAIL_CHARS = 6_000;

export function activeVisualHtmlForPrompt(html: string): { html: string; omittedChars: number } {
  if (html.length <= ACTIVE_VISUAL_PROMPT_MAX_CHARS) {
    return { html, omittedChars: 0 };
  }
  const headChars = ACTIVE_VISUAL_PROMPT_MAX_CHARS - ACTIVE_VISUAL_PROMPT_TAIL_CHARS;
  const omittedChars = html.length - headChars - ACTIVE_VISUAL_PROMPT_TAIL_CHARS;
  return {
    html: [
      html.slice(0, headChars),
      `\n<!-- Active visual HTML truncated: ${omittedChars} chars omitted. -->\n`,
      html.slice(-ACTIVE_VISUAL_PROMPT_TAIL_CHARS),
    ].join(""),
    omittedChars,
  };
}

export function isRuntimeTool(name: string, toolName: string): boolean {
  return name === toolName || name.endsWith(`__${toolName}`);
}

export function isVisualsShowHtmlTool(name: string): boolean {
  return isRuntimeTool(name, "show_html");
}

export function isVisualsShowMermaidTool(name: string): boolean {
  return isRuntimeTool(name, "show_mermaid");
}

export function isVisualsShowImageTool(name: string): boolean {
  return isRuntimeTool(name, "show_image");
}

export function isVisualsShowVideoTool(name: string): boolean {
  return isRuntimeTool(name, "show_video");
}

export function normalizeToolUseId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function stripMermaidFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:mermaid)?\s*\n([\s\S]*?)\n```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

export function topicAllowsVisualFileId(topicId: string, fileId: string): boolean {
  if (!isUploadFileId(fileId)) return false;
  return topicHasAttachmentFileId(topicId, fileId) || topicHasVisualFileId(topicId, fileId);
}

export function isPathInside(baseDir: string, filePath: string): boolean {
  const base = resolve(baseDir);
  const normalized = resolve(filePath);
  if (normalized !== base && !normalized.startsWith(`${base}/`)) return false;
  try {
    const real = realpathSync(normalized);
    return real === base || real.startsWith(`${base}/`);
  } catch {
    return false;
  }
}

export function buildImageHtml(alt: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    html,body{margin:0;width:100%;min-height:100%;background:#111827}
    body{display:grid;place-items:center;padding:16px;box-sizing:border-box}
    img{max-width:100%;max-height:calc(100vh - 32px);object-fit:contain;background:#fff}
  </style>
</head>
<body><img src="${VISUAL_MEDIA_URL_PLACEHOLDER}" alt="${escapeHtml(alt)}"></body>
</html>`;
}

export function buildVideoHtml(mimeType: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    html,body{margin:0;width:100%;min-height:100%;background:#0b1020}
    body{display:grid;place-items:center;padding:16px;box-sizing:border-box}
    video{width:100%;max-width:1200px;max-height:calc(100vh - 32px);background:#000}
  </style>
</head>
<body><video controls playsinline preload="metadata" src="${VISUAL_MEDIA_URL_PLACEHOLDER}" data-mime="${escapeHtml(mimeType)}"></video></body>
</html>`;
}

export function resolveVisualMediaInput(
  topicId: string,
  input: { file_path?: unknown; file_id?: unknown },
): { fileId: string; mimeType: string; source: string } | { error: string } {
  if (typeof input.file_id === "string" && input.file_id.trim()) {
    const fileId = input.file_id.trim().toLowerCase();
    if (!isUploadFileId(fileId)) return { error: "file_id must be a full uploaded-file UUID" };
    if (!topicAllowsVisualFileId(topicId, fileId)) {
      return { error: "file_id is not attached to this topic" };
    }
    const attachment = resolveAttachmentByFileId(fileId);
    const filePath = resolveUploadedFilePathByFileId(fileId);
    if (!attachment || !filePath) return { error: `uploaded file not found: ${fileId}` };
    return {
      fileId: attachment.id,
      mimeType: attachment.mimeType,
      source: `file_id:${attachment.id}`,
    };
  }

  if (typeof input.file_path !== "string" || !input.file_path.trim()) {
    return { error: "file_path or file_id is required" };
  }
  const rawPath = input.file_path.trim();
  const cwd = workspaceCwdFor(topicId);
  const candidate = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  if (!isPathInside(cwd, candidate)) {
    return { error: "file_path must be inside the topic workspace" };
  }
  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    return { error: `file not found: ${rawPath}` };
  }
  if (isSensitivePath(realCandidate)) {
    return { error: "file_path matches the sensitive-file blacklist" };
  }
  const attachment = storeLocalFileAsUpload(realCandidate, { topicId });
  if (!attachment) return { error: `failed to store media file: ${rawPath}` };
  const filePath = resolveUploadedFilePathByFileId(attachment.id);
  if (!filePath) return { error: `stored media file disappeared: ${attachment.id}` };
  return {
    fileId: attachment.id,
    mimeType: attachment.mimeType,
    source: rawPath,
  };
}
