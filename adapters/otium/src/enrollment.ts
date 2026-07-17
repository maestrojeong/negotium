import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomUUID,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DATA_DIR } from "@negotium/core";
import type { OtiumJoin } from "@/join";

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

function loadOrCreatePending(invite: EnrollmentInvite): PendingEnrollment {
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
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return pending;
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
  const pending = loadOrCreatePending(invite);
  const response = await postJson<EnrollmentClaimResponse>(
    `${invite.central}/api/v1/node-enrollments/claim`,
    {
      token: invite.token,
      credentialPublicKey: pending.publicKey,
      ...(nodeName ? { nodeName } : {}),
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
  unlinkSync(pendingEnrollmentPath());
  return join;
}
