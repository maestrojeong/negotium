import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DATA_DIR } from "@negotium/core";
import {
  isJoinPersisted,
  joinCredentialDigest,
  type OtiumJoin,
  type SaveJoinOptions,
  saveJoinWhileLocked,
  withJoinCredentialLock,
} from "@/join";

const INFO = Buffer.from("otium-node-enrollment-v1", "utf8");

export interface EnrollmentInvite {
  v: 2;
  central: string;
  token: string;
}

interface PendingEnrollment extends EnrollmentInvite {
  idempotencyKey: string;
  privateKey: string;
  publicKey: string;
  /** Frozen with the idempotency key so retries replay the same claim body. */
  nodeName?: string;
  claimed?: {
    digest: string;
    cellId: string;
  };
}

export interface EnrollmentCredentialEnvelope {
  v: 1;
  algorithm: "X25519-HKDF-SHA256-AES-256-GCM";
  ephemeralPublicKey: string;
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface EnrollmentPreviewResponse {
  ok: true;
  preview: {
    workspace: { id: string; slug: string; name: string };
    suggestedNodeName: string | null;
    transport: "relay";
    relayUrl: string;
    expiresAt: string;
    status: string;
    topics: string;
  };
}

interface EnrollmentClaimResponse {
  ok: true;
  relayUrl: string;
  cell: { id: string; baseUrl: string };
  credential: EnrollmentCredentialEnvelope;
}

export function parseEnrollmentInvite(code: string): EnrollmentInvite {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(code.trim(), "base64url").toString("utf8"));
  } catch {
    throw new Error("production invite must be base64url JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("production invite must decode to an object");
  }
  const raw = parsed as Record<string, unknown>;
  const central = typeof raw.central === "string" ? raw.central.trim().replace(/\/+$/, "") : "";
  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  if (raw.v !== 2 || !/^https?:\/\//.test(central) || !token.startsWith("nei_")) {
    throw new Error("production invite requires {v:2, central:http(s), token:nei_…}");
  }
  return { v: 2, central, token };
}

export function pendingEnrollmentPath(): string {
  return resolve(DATA_DIR, "otium-enrollment-pending.json");
}

export function isEnrollmentPending(invite: EnrollmentInvite): boolean {
  const path = pendingEnrollmentPath();
  if (!existsSync(path)) return false;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as PendingEnrollment;
    return saved.central === invite.central && saved.token === invite.token;
  } catch {
    return false;
  }
}

function loadOrCreatePending(invite: EnrollmentInvite, nodeName?: string): PendingEnrollment {
  const path = pendingEnrollmentPath();
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8")) as PendingEnrollment;
    if (saved.central === invite.central && saved.token === invite.token) return saved;
    throw new Error(`another Otium enrollment is pending at ${path}`);
  }
  const pair = generateKeyPairSync("x25519");
  const pending: PendingEnrollment = {
    ...invite,
    idempotencyKey: randomUUID(),
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    ...(nodeName ? { nodeName } : {}),
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = resolve(
    dirname(path),
    `.otium-enrollment-pending.json.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Publish only the completely written key material and never overwrite a
    // concurrent enrollment created by another process.
    linkSync(temporaryPath, path);
    unlinkSync(temporaryPath);
    chmodSync(path, 0o600);
    const directoryFd = openSync(dirname(path), "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, "utf8")) as PendingEnrollment;
      if (saved.central === invite.central && saved.token === invite.token) return saved;
    }
    throw error;
  }
  return pending;
}

function replacePendingEnrollment(pending: PendingEnrollment): void {
  const path = pendingEnrollmentPath();
  const directory = dirname(path);
  const temporaryPath = resolve(
    directory,
    `.otium-enrollment-pending.json.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, path);
    const directoryFd = openSync(directory, "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

function recordClaimedCredential(pending: PendingEnrollment, join: OtiumJoin): void {
  withJoinCredentialLock(() => {
    const current = JSON.parse(readFileSync(pendingEnrollmentPath(), "utf8")) as PendingEnrollment;
    if (
      current.central !== pending.central ||
      current.token !== pending.token ||
      current.idempotencyKey !== pending.idempotencyKey ||
      current.publicKey !== pending.publicKey
    ) {
      throw new Error("pending Otium enrollment changed while its claim was in flight");
    }
    const claimed = { digest: joinCredentialDigest(join), cellId: join.cellId };
    if (
      current.claimed &&
      (current.claimed.digest !== claimed.digest || current.claimed.cellId !== claimed.cellId)
    ) {
      throw new Error("central returned different credentials for an idempotent enrollment claim");
    }
    replacePendingEnrollment({ ...current, claimed });
  });
}

function openCredential(envelope: EnrollmentCredentialEnvelope, privateKeyDer: string): string {
  if (envelope.v !== 1 || envelope.algorithm !== "X25519-HKDF-SHA256-AES-256-GCM") {
    throw new Error("unsupported enrollment credential envelope");
  }
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyDer, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const ephemeral = createPublicKey({
    key: Buffer.from(envelope.ephemeralPublicKey, "base64url"),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({ privateKey, publicKey: ephemeral });
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.from(envelope.salt, "base64url"), INFO, 32),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64url"));
  decipher.setAAD(INFO);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

async function postJson<T>(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.error || `request failed (${response.status})`));
  return result as T;
}

export async function previewEnrollment(
  invite: EnrollmentInvite,
): Promise<EnrollmentPreviewResponse> {
  return postJson<EnrollmentPreviewResponse>(`${invite.central}/api/v1/node-enrollments/preview`, {
    token: invite.token,
  });
}

export async function claimEnrollment(
  invite: EnrollmentInvite,
  nodeName?: string,
): Promise<OtiumJoin> {
  const pending = loadOrCreatePending(invite, nodeName);
  const response = await postJson<EnrollmentClaimResponse>(
    `${invite.central}/api/v1/node-enrollments/claim`,
    {
      token: invite.token,
      credentialPublicKey: pending.publicKey,
      ...(pending.nodeName ? { nodeName: pending.nodeName } : {}),
    },
    { "idempotency-key": pending.idempotencyKey },
  );
  const credential = response.credential as EnrollmentCredentialEnvelope;
  const secret = openCredential(credential, pending.privateKey);
  if (!secret.startsWith("rcs_")) throw new Error("central returned an invalid runtime credential");
  const join: OtiumJoin = {
    v: 2,
    central: invite.central,
    relay: String(response.relayUrl),
    cellId: String(response.cell?.id),
    secret,
  };
  if (!join.relay || !join.cellId || join.cellId === "undefined") {
    throw new Error("central returned an incomplete enrollment response");
  }
  recordClaimedCredential(pending, join);
  return join;
}

/**
 * Durably commit a claimed enrollment. The retry key is deliberately removed
 * only after the atomic join-file save is fsynced and verified. A crash before
 * that point leaves enough key material to replay the idempotent claim.
 */
export function commitEnrollment(join: OtiumJoin, options: SaveJoinOptions = {}): string {
  return withJoinCredentialLock(() => {
    const pendingPath = pendingEnrollmentPath();
    const pending = existsSync(pendingPath)
      ? (JSON.parse(readFileSync(pendingPath, "utf8")) as PendingEnrollment)
      : null;
    const digest = joinCredentialDigest(join);
    if (
      pending &&
      (!pending.claimed ||
        pending.claimed.digest !== digest ||
        pending.claimed.cellId !== join.cellId)
    ) {
      throw new Error(
        `pending Otium enrollment at ${pendingPath} does not match these credentials`,
      );
    }

    const path = saveJoinWhileLocked(join, options);
    if (!isJoinPersisted(join)) {
      throw new Error("Otium join credentials were not durably persisted");
    }
    if (!pending) return path;

    // The same lock protects save→verification→pending deletion from a
    // concurrent explicit replacement through saveJoin().
    unlinkSync(pendingPath);
    const directoryFd = openSync(dirname(pendingPath), "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    return path;
  });
}
