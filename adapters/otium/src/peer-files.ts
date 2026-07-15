import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { AttachmentDto } from "@negotium/core";
import { DATA_DIR, db, type FileHooks, fileHooks, setFileHooks } from "@negotium/core";

const PEER_FILES_DIR = join(DATA_DIR, "otium-peer-files");

db.exec(`
  CREATE TABLE IF NOT EXISTS otium_peer_files (
    id TEXT PRIMARY KEY,
    topic_id TEXT,
    owner_user_id TEXT,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

interface PeerFileRow {
  id: string;
  topic_id: string | null;
  owner_user_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  path: string;
}

function fileType(mimeType: string): AttachmentDto["type"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function attachment(row: PeerFileRow): AttachmentDto {
  return {
    id: row.id,
    type: fileType(row.mime_type),
    filename: row.filename,
    url: `/api/v1/peer/files/${row.id}`,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
  };
}

function rowFor(fileId: string): PeerFileRow | null {
  return (
    db.query<PeerFileRow, [string]>("SELECT * FROM otium_peer_files WHERE id = ?").get(fileId) ??
    null
  );
}

export function peerFileAllowsAccess(
  fileId: string,
  access: { topicId: string; ownerUserId: string },
): boolean {
  const row = rowFor(fileId);
  return row?.topic_id === access.topicId && row.owner_user_id === access.ownerUserId;
}

function safeFilename(filename: string): string {
  const value = basename(filename)
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .slice(0, 120);
  return value || "upload";
}

function mimeFromPath(path: string): string {
  const extension = extname(path).toLowerCase();
  const known: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
  };
  return known[extension] ?? "application/octet-stream";
}

function recordFile(args: {
  id: string;
  path: string;
  sizeBytes: number;
  filename: string;
  mimeType: string;
  topicId?: string;
  ownerUserId?: string;
}): AttachmentDto {
  db.run(
    `INSERT INTO otium_peer_files
       (id, topic_id, owner_user_id, filename, mime_type, size_bytes, path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      args.topicId ?? null,
      args.ownerUserId ?? null,
      args.filename,
      args.mimeType,
      args.sizeBytes,
      args.path,
      new Date().toISOString(),
    ],
  );
  return attachment({
    id: args.id,
    topic_id: args.topicId ?? null,
    owner_user_id: args.ownerUserId ?? null,
    filename: args.filename,
    mime_type: args.mimeType,
    size_bytes: args.sizeBytes,
    path: args.path,
  });
}

function insertLocalFile(args: {
  sourcePath: string;
  filename: string;
  mimeType: string;
  topicId?: string;
  ownerUserId?: string;
}): AttachmentDto {
  const id = randomUUID();
  mkdirSync(PEER_FILES_DIR, { recursive: true });
  const path = join(PEER_FILES_DIR, `${id}-${safeFilename(args.filename)}`);
  copyFileSync(args.sourcePath, path);
  return recordFile({ id, path, sizeBytes: statSync(path).size, ...args });
}

function deletePeerFilesForTopic(topicId: string): void {
  const rows = db
    .query<Pick<PeerFileRow, "path">, [string]>(
      "SELECT path FROM otium_peer_files WHERE topic_id = ?",
    )
    .all(topicId);
  db.run("DELETE FROM otium_peer_files WHERE topic_id = ?", [topicId]);
  for (const row of rows) rmSync(row.path, { force: true });
}

export async function storePeerInputFile(
  file: File,
  access: { topicId: string; ownerUserId: string },
): Promise<AttachmentDto> {
  const id = randomUUID();
  mkdirSync(PEER_FILES_DIR, { recursive: true });
  const filename = file.name || "upload";
  const path = join(PEER_FILES_DIR, `${id}-${safeFilename(filename)}`);
  const sizeBytes = await Bun.write(path, file);
  return recordFile({
    id,
    path,
    sizeBytes,
    filename,
    mimeType: file.type || "application/octet-stream",
    ...access,
  });
}

export function installPeerFileHooks(): () => void {
  const previous = fileHooks();
  const hooks: FileHooks = {
    resolveAttachmentByFileId(fileId) {
      const row = rowFor(fileId);
      return row ? attachment(row) : previous.resolveAttachmentByFileId(fileId);
    },
    resolveUploadedFilePathByFileId(fileId) {
      return rowFor(fileId)?.path ?? previous.resolveUploadedFilePathByFileId(fileId);
    },
    storeLocalFileAsUpload(path, access) {
      const existing = previous.storeLocalFileAsUpload(path, access);
      if (existing) return existing;
      return insertLocalFile({
        sourcePath: path,
        filename: basename(path),
        mimeType: mimeFromPath(path),
        topicId: access?.topicId,
        ownerUserId: access?.ownerUserId,
      });
    },
    async deleteFilesForTopic(topicId) {
      await previous.deleteFilesForTopic?.(topicId);
      deletePeerFilesForTopic(topicId);
    },
  };
  setFileHooks(hooks);
  return () => {
    if (fileHooks() === hooks) setFileHooks(previous);
  };
}
