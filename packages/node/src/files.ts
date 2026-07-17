import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import {
  type AttachmentDto,
  DATA_DIR,
  type FileHooks,
  getTopic,
  isParticipant,
  logger,
  type UploadAccess,
} from "@negotium/core";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NodeUploadMetadata {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  savedName: string;
  ownerUserId?: string;
  topicId?: string;
  visibility?: "private" | "workspace";
}

const MIME_BY_EXT: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

function safeExtension(filename: string): string {
  const extension = extname(basename(filename));
  return /^\.[A-Za-z0-9]{1,16}$/.test(extension) ? extension.toLowerCase() : "";
}

function attachmentType(mimeType: string): AttachmentDto["type"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function contentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export class NodeFileStore {
  readonly uploadDir: string;

  constructor(uploadDir = join(DATA_DIR, "uploads")) {
    this.uploadDir = uploadDir;
  }

  #ensureDir(): void {
    mkdirSync(this.uploadDir, { recursive: true });
  }

  #metadataPath(fileId: string): string {
    return join(this.uploadDir, `${fileId}.meta.json`);
  }

  #metadata(fileId: string): NodeUploadMetadata | null {
    if (!FILE_ID_RE.test(fileId)) return null;
    try {
      const parsed = JSON.parse(
        readFileSync(this.#metadataPath(fileId), "utf8"),
      ) as NodeUploadMetadata;
      if (
        typeof parsed.filename !== "string" ||
        typeof parsed.mimeType !== "string" ||
        typeof parsed.sizeBytes !== "number" ||
        typeof parsed.savedName !== "string"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  #attachment(fileId: string, metadata: NodeUploadMetadata): AttachmentDto {
    const userQuery = metadata.ownerUserId
      ? `?user=${encodeURIComponent(metadata.ownerUserId)}`
      : "";
    return {
      id: fileId,
      type: attachmentType(metadata.mimeType),
      filename: metadata.filename,
      url: `/api/v1/control/files/${fileId}${userQuery}`,
      mimeType: metadata.mimeType,
      sizeBytes: metadata.sizeBytes,
    };
  }

  readonly hooks: FileHooks = {
    resolveAttachmentByFileId: (fileId) => {
      const metadata = this.#metadata(fileId);
      if (!metadata || !existsSync(join(this.uploadDir, metadata.savedName))) return null;
      return this.#attachment(fileId, metadata);
    },
    resolveUploadedFilePathByFileId: (fileId) => {
      const metadata = this.#metadata(fileId);
      if (!metadata) return null;
      const path = join(this.uploadDir, metadata.savedName);
      return existsSync(path) ? path : null;
    },
    storeLocalFileAsUpload: (absPath, access = {}) => this.store(absPath, access),
    deleteFilesForTopic: (topicId) => this.deleteForTopic(topicId),
  };

  store(absPath: string, access: UploadAccess = {}): AttachmentDto | null {
    this.#ensureDir();
    const fileId = randomUUID();
    const extension = safeExtension(absPath);
    const savedName = `${fileId}${extension}`;
    const savedPath = join(this.uploadDir, savedName);
    try {
      const stats = statSync(absPath);
      if (!stats.isFile() || stats.size > MAX_UPLOAD_BYTES) return null;
      const metadata: NodeUploadMetadata = {
        filename: basename(absPath),
        mimeType: MIME_BY_EXT[extension] ?? "application/octet-stream",
        sizeBytes: stats.size,
        savedName,
        ...(access.ownerUserId ? { ownerUserId: access.ownerUserId } : {}),
        ...(access.topicId ? { topicId: access.topicId } : {}),
        ...(access.visibility ? { visibility: access.visibility } : {}),
      };
      copyFileSync(absPath, savedPath);
      writeFileSync(this.#metadataPath(fileId), JSON.stringify(metadata), { mode: 0o600 });
      return this.#attachment(fileId, metadata);
    } catch (error) {
      rmSync(savedPath, { force: true });
      rmSync(this.#metadataPath(fileId), { force: true });
      logger.warn({ err: error, absPath }, "node files: failed to store local upload");
      return null;
    }
  }

  response(fileId: string, userId: string): Response | null {
    const metadata = this.#metadata(fileId);
    if (!metadata) return null;
    const topic = metadata.topicId ? getTopic(metadata.topicId) : null;
    const allowed =
      metadata.visibility === "workspace" ||
      metadata.ownerUserId === userId ||
      Boolean(topic && isParticipant(topic, userId));
    if (!allowed) return null;
    const path = join(this.uploadDir, metadata.savedName);
    if (!existsSync(path)) return null;
    return new Response(Bun.file(path), {
      headers: {
        "content-disposition": contentDisposition(metadata.filename),
        "content-length": String(metadata.sizeBytes),
        "content-type": metadata.mimeType,
        "x-content-type-options": "nosniff",
      },
    });
  }

  deleteForTopic(topicId: string): void {
    this.#ensureDir();
    for (const name of new Bun.Glob("*.meta.json").scanSync({ cwd: this.uploadDir })) {
      const fileId = name.slice(0, -".meta.json".length);
      const metadata = this.#metadata(fileId);
      if (metadata?.topicId !== topicId) continue;
      rmSync(join(this.uploadDir, metadata.savedName), { force: true });
      rmSync(this.#metadataPath(fileId), { force: true });
    }
  }
}

export const nodeFileStore = new NodeFileStore();
