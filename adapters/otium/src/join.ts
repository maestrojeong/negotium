/**
 * otium node join credentials — the v0 "invite code" is a base64url JSON
 * bundle `{ v, central, cellId, secret }` produced by the hub operator
 * (scripts/otium-experiment/hub-setup.ts). `negotium otium join <code>` decodes it
 * and persists it under `${DATA_DIR}/otium-join.json` (0600); `serve` mounts
 * the peer routes whenever that file (or the env triple) is present.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DATA_DIR, logger } from "@negotium/core";

export interface OtiumJoin {
  /** Invite code format version (v0 bundles carry 1). */
  v?: number;
  /** central-api origin, e.g. "http://127.0.0.1:4600". */
  central: string;
  /** Optional relay origin used for outbound NAT traversal. */
  relay?: string;
  /** This node's runtime cell id (cell_…). */
  cellId: string;
  /** This node's runtime cell secret (rcs_…) — never leaves this process. */
  secret: string;
}

export function joinFilePath(): string {
  return resolve(DATA_DIR, "otium-join.json");
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function isRelayUrl(value: string): boolean {
  return /^(?:https?|wss?):\/\//.test(value);
}

function normalizeJoin(raw: Record<string, unknown>): OtiumJoin {
  const central = typeof raw.central === "string" ? raw.central.trim().replace(/\/+$/, "") : "";
  const relay = typeof raw.relay === "string" ? raw.relay.trim().replace(/\/+$/, "") : "";
  const cellId = typeof raw.cellId === "string" ? raw.cellId.trim() : "";
  const secret = typeof raw.secret === "string" ? raw.secret.trim() : "";
  if (!central || !isHttpUrl(central)) {
    throw new Error("invite code is missing a valid http(s) central URL");
  }
  if (relay && !isRelayUrl(relay)) throw new Error("invite code has an invalid relay URL");
  if (!cellId) throw new Error("invite code is missing cellId");
  if (!secret) throw new Error("invite code is missing secret");
  return {
    ...(typeof raw.v === "number" ? { v: raw.v } : {}),
    central,
    ...(relay ? { relay } : {}),
    cellId,
    secret,
  };
}

/** Decode a v0 invite code: base64url(JSON {v, central, cellId, secret}). */
export function parseInviteCode(code: string): OtiumJoin {
  const trimmed = code.trim();
  if (!trimmed) throw new Error("invite code is empty");
  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, "base64url").toString("utf-8");
  } catch {
    throw new Error("invite code is not valid base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("invite code does not decode to JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invite code does not decode to a JSON object");
  }
  return normalizeJoin(parsed as Record<string, unknown>);
}

/** Persist join credentials (0600 — the cell secret is a bearer credential). */
export function saveJoin(join: OtiumJoin): string {
  const path = joinFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(join, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/**
 * Load join credentials. Env triple (OTIUM_CENTRAL_URL / OTIUM_CELL_ID /
 * OTIUM_CELL_SECRET) wins when all three are set — same values `negotium
 * join` persists, useful for tests and multi-node-on-one-box. Fail-closed:
 * a partial env triple or a corrupt file yields null (worker stays off).
 */
export function loadJoin(): OtiumJoin | null {
  const central = process.env.OTIUM_CENTRAL_URL?.trim();
  const cellId = process.env.OTIUM_CELL_ID?.trim();
  const secret = process.env.OTIUM_CELL_SECRET?.trim();
  const relay = process.env.OTIUM_RELAY_URL?.trim();
  if (central && cellId && secret) {
    try {
      return normalizeJoin({ central, relay, cellId, secret });
    } catch (err) {
      logger.warn({ err }, "otium: invalid OTIUM_CENTRAL_URL/OTIUM_CELL_ID/OTIUM_CELL_SECRET env");
      return null;
    }
  }
  if (central || cellId || secret) {
    logger.warn(
      "otium: OTIUM_CENTRAL_URL, OTIUM_CELL_ID, OTIUM_CELL_SECRET must be set together — ignoring partial env",
    );
  }
  const path = joinFilePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return normalizeJoin(parsed as Record<string, unknown>);
  } catch (err) {
    logger.warn({ err, path }, "otium: failed to read join file");
    return null;
  }
}
