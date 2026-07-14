import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { logger } from "#platform/logger";
import { resolveAttachmentByFileId, resolveUploadedFilePathByFileId } from "#runtime/file-hooks";
import type { AgentInputAttachment } from "#types";

/** Agent working directory for a topic (mirrors the cwd set in the POST handler). */
export function workspaceCwdFor(topicId: string): string {
  return resolveTopicWorkspaceDir(topicId);
}

export function safeAttachmentFilename(filename: string, fileId: string): string {
  const base = basename(filename || fileId);
  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 100);
  return cleaned || fileId;
}

export function materializePromptAttachments(
  topicId: string,
  queryId: string,
  attachmentIds: string[] | undefined,
): AgentInputAttachment[] {
  if (!attachmentIds?.length) return [];

  const seen = new Set<string>();
  const out: AgentInputAttachment[] = [];
  const destDir = join(workspaceCwdFor(topicId), "attachments", queryId);

  for (const rawId of attachmentIds) {
    if (typeof rawId !== "string") continue;
    const fileId = rawId.trim();
    if (!fileId || seen.has(fileId)) continue;
    seen.add(fileId);

    const attachment = resolveAttachmentByFileId(fileId);
    const sourcePath = resolveUploadedFilePathByFileId(fileId);
    if (!attachment || !sourcePath) {
      logger.warn({ topicId, queryId, fileId }, "ai: attachment file id could not be resolved");
      continue;
    }

    try {
      mkdirSync(destDir, { recursive: true });
      const index = String(out.length + 1).padStart(2, "0");
      const safeName = safeAttachmentFilename(attachment.filename, fileId);
      const destPath = join(destDir, `${index}-${fileId.slice(0, 8)}-${safeName}`);
      copyFileSync(sourcePath, destPath);
      out.push({
        id: attachment.id,
        type: attachment.type,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        path: destPath,
      });
    } catch (err) {
      logger.warn({ topicId, queryId, fileId, err }, "ai: failed to materialize attachment");
    }
  }

  return out;
}

/** Canonical inbound-attachment prompt line — the one convention every host
 *  (web upload flow, channel adapters) uses to point the agent at a file. */
export function attachmentPromptLine(filename: string, path: string): string {
  return `[Attached file: ${filename} at path: ${path}]`;
}

/** Compose the final turn prompt from user text + attachment prompt lines
 *  (see {@link attachmentPromptLine}). Empty text gets the canonical
 *  "please look at this file" fallback so the turn always has a user ask. */
export function composeAttachmentPrompt(prompt: string, promptLines: string[]): string {
  if (promptLines.length === 0) return prompt;
  const userText = prompt.trim() ? prompt : "이 파일을 확인해주세요.";
  return [userText, "", ...promptLines].join("\n");
}

export function promptWithAttachments(prompt: string, attachments: AgentInputAttachment[]): string {
  return composeAttachmentPrompt(
    prompt,
    attachments.map(({ filename, path }) => attachmentPromptLine(filename, path)),
  );
}

export interface IngestAttachmentArgs {
  topicId: string;
  filename: string;
  /** Raw file content (e.g. downloaded from a channel API). */
  bytes?: Uint8Array;
  /** Alternative to `bytes`: copy an existing local file. */
  sourcePath?: string;
}

export interface IngestedAttachment {
  /** Absolute path of the stored copy inside the topic workspace. */
  path: string;
  filename: string;
  /** Ready-to-use prompt fragment ({@link attachmentPromptLine}). */
  promptLine: string;
}

/**
 * Store an inbound channel attachment in the topic's workspace (`uploads/`)
 * and return the canonical prompt fragment for it. Single implementation of
 * the "download → workspace → [Attached file: …] line" intake used by every
 * channel adapter (ported from clawgram's buildPromptFromMessage convention).
 */
export function ingestAttachment(args: IngestAttachmentArgs): IngestedAttachment {
  const destDir = join(workspaceCwdFor(args.topicId), "uploads");
  mkdirSync(destDir, { recursive: true });
  const safeName = safeAttachmentFilename(args.filename, "upload");
  // Timestamp alone collides for same-name files ingested in the same ms
  // (e.g. a Telegram album of "photo.jpg"s) — add a random discriminator.
  const destPath = join(destDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`);
  if (args.sourcePath !== undefined) {
    copyFileSync(args.sourcePath, destPath);
  } else if (args.bytes !== undefined) {
    writeFileSync(destPath, args.bytes);
  } else {
    throw new Error("ingestAttachment: provide sourcePath or bytes");
  }
  return {
    path: destPath,
    filename: args.filename,
    promptLine: attachmentPromptLine(args.filename, destPath),
  };
}

export function parseAttachmentNames(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return undefined;
        const record = item as Record<string, unknown>;
        const name = record.filename ?? record.name ?? record.id;
        return typeof name === "string" && name.trim() ? name.trim() : undefined;
      })
      .filter((name): name is string => Boolean(name));
  } catch {
    return [];
  }
}
