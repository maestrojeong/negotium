/**
 * FileHooks — pluggable seam for the host's upload/attachment subsystem.
 *
 * The otium runtime resolves uploaded files through its REST `files` route
 * (`resolveAttachmentByFileId` / `resolveUploadedFilePathByFileId` /
 * `storeLocalFileAsUpload`). Negotium core has no uploads subsystem: whatever
 * host embeds the runtime owns file storage and installs its implementation
 * here with `setFileHooks()`. The default implementation resolves nothing, so
 * a headless runtime degrades gracefully (attachments are skipped with a
 * warning, media visuals report "uploaded file not found").
 */

import type { AttachmentDto } from "#types/api";

export interface UploadAccess {
  ownerUserId?: string;
  topicId?: string;
  visibility?: "private" | "workspace";
}

export interface FileHooks {
  /** Metadata for an uploaded file id, or null when unknown. */
  resolveAttachmentByFileId(fileId: string): AttachmentDto | null;
  /** Absolute on-disk path for an uploaded file id, or null when unknown. */
  resolveUploadedFilePathByFileId(fileId: string): string | null;
  /** Register a local file as an upload (used by media visuals). Null on failure. */
  storeLocalFileAsUpload(absPath: string, access?: UploadAccess): AttachmentDto | null;
  /** Delete host-owned uploads scoped exclusively to a hard-deleted topic. */
  deleteFilesForTopic?(topicId: string): void | Promise<void>;
}

/** No-uploads default: every lookup misses. */
const noopFileHooks: FileHooks = {
  resolveAttachmentByFileId: () => null,
  resolveUploadedFilePathByFileId: () => null,
  storeLocalFileAsUpload: () => null,
};

let current: FileHooks = noopFileHooks;

export function fileHooks(): FileHooks {
  return current;
}

export function setFileHooks(hooks: FileHooks): void {
  current = hooks;
}

export function resetFileHooks(): void {
  current = noopFileHooks;
}

// ── Pure helpers (no host storage involved) ────────────────────────────

const UPLOAD_FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value has the shape of an uploaded-file id (full UUID). */
export function isUploadFileId(value: string): boolean {
  return UPLOAD_FILE_ID_RE.test(value);
}

/** Convenience passthroughs so ported call sites read like the originals. */
export function resolveAttachmentByFileId(fileId: string): AttachmentDto | null {
  return current.resolveAttachmentByFileId(fileId);
}

export function resolveUploadedFilePathByFileId(fileId: string): string | null {
  return current.resolveUploadedFilePathByFileId(fileId);
}

export function storeLocalFileAsUpload(
  absPath: string,
  access: UploadAccess = {},
): AttachmentDto | null {
  return current.storeLocalFileAsUpload(absPath, access);
}

/** Notify the embedding host that topic-scoped uploads may now be removed. */
export async function deleteFilesForTopic(topicId: string): Promise<void> {
  await current.deleteFilesForTopic?.(topicId);
}
