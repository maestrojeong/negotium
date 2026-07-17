import { afterEach, describe, expect, test } from "bun:test";
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { existsSync, statSync, unlinkSync } from "node:fs";
import {
  claimEnrollment,
  commitEnrollment,
  isEnrollmentPending,
  parseEnrollmentInvite,
  pendingEnrollmentPath,
  previewEnrollment,
} from "@/enrollment";
import { joinFilePath, loadJoin, saveJoin } from "@/join";

const INFO = Buffer.from("otium-node-enrollment-v1", "utf8");

function seal(secret: string, recipientDer: string) {
  const recipient = createPublicKey({
    key: Buffer.from(recipientDer, "base64url"),
    format: "der",
    type: "spki",
  });
  const ephemeral = generateKeyPairSync("x25519");
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync("sha256", shared, salt, INFO, 32));
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(INFO);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    v: 1,
    algorithm: "X25519-HKDF-SHA256-AES-256-GCM",
    ephemeralPublicKey: ephemeral.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url"),
    salt: salt.toString("base64url"),
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

afterEach(() => {
  if (existsSync(pendingEnrollmentPath())) unlinkSync(pendingEnrollmentPath());
  if (existsSync(joinFilePath())) unlinkSync(joinFilePath());
});

describe("production enrollment client", () => {
  test("parses v2 invite codes and rejects legacy payloads", () => {
    const code = Buffer.from(
      JSON.stringify({ v: 2, central: "https://api.example/", token: "nei_token" }),
    ).toString("base64url");
    expect(parseEnrollmentInvite(code)).toEqual({
      v: 2,
      central: "https://api.example",
      token: "nei_token",
    });
    expect(() =>
      parseEnrollmentInvite(
        Buffer.from(JSON.stringify({ v: 1, central: "https://api.example" })).toString("base64url"),
      ),
    ).toThrow("v:2");
  });

  test("previews, claims, decrypts, and removes retry state only after commit", async () => {
    const secret = "rcs_encrypted-test-secret";
    let idempotencyKey = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = (await req.json()) as Record<string, string>;
        if (url.pathname.endsWith("/preview")) {
          return Response.json({
            ok: true,
            preview: {
              workspace: { id: "ws_1", slug: "test", name: "Test" },
              suggestedNodeName: "worker-one",
              transport: "relay",
              relayUrl: "https://relay.example",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              status: "pending",
              topics: "only explicitly shared topics",
            },
          });
        }
        idempotencyKey = req.headers.get("idempotency-key") ?? "";
        return Response.json({
          ok: true,
          relayUrl: "https://relay.example",
          cell: { id: "cell_worker", baseUrl: "https://relay.example/n/cell_worker" },
          credential: seal(secret, body.credentialPublicKey!),
        });
      },
    });
    try {
      const invite = {
        v: 2 as const,
        central: `http://127.0.0.1:${server.port}`,
        token: "nei_test",
      };
      expect((await previewEnrollment(invite)).preview.workspace.name).toBe("Test");
      const join = await claimEnrollment(invite, "worker-one");
      expect(join).toEqual({
        v: 2,
        central: invite.central,
        relay: "https://relay.example",
        cellId: "cell_worker",
        secret,
      });
      expect(idempotencyKey.length).toBeGreaterThan(10);
      expect(existsSync(pendingEnrollmentPath())).toBe(true);
      commitEnrollment(join);
      expect(existsSync(pendingEnrollmentPath())).toBe(false);
      expect(loadJoin()).toEqual(join);
    } finally {
      server.stop(true);
    }
  });

  test("keeps retry state at 0600 when claim transport fails", async () => {
    const invite = { v: 2 as const, central: "http://127.0.0.1:1", token: "nei_retry" };
    await expect(claimEnrollment(invite)).rejects.toThrow();
    expect(statSync(pendingEnrollmentPath()).mode & 0o777).toBe(0o600);
  });

  test("keeps retry material when join persistence fails, then resumes idempotently", async () => {
    const secret = "rcs_resume-secret";
    let claims = 0;
    const idempotencyKeys = new Set<string>();
    const credentialPublicKeys = new Set<string>();
    const requestedNodeNames: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        claims += 1;
        const body = (await req.json()) as Record<string, string>;
        idempotencyKeys.add(req.headers.get("idempotency-key") ?? "");
        credentialPublicKeys.add(body.credentialPublicKey!);
        requestedNodeNames.push(body.nodeName!);
        return Response.json({
          ok: true,
          relayUrl: "https://relay.example",
          cell: { id: "cell_resume", baseUrl: "https://relay.example/n/cell_resume" },
          credential: seal(secret, body.credentialPublicKey!),
        });
      },
    });
    try {
      const invite = {
        v: 2 as const,
        central: `http://127.0.0.1:${server.port}`,
        token: "nei_resume",
      };
      const first = await claimEnrollment(invite, "worker-original");
      expect(isEnrollmentPending(invite)).toBe(true);
      saveJoin({ central: "https://other.example", cellId: "cell_other", secret: "rcs_other" });
      expect(() => commitEnrollment(first)).toThrow("already joined");
      expect(existsSync(pendingEnrollmentPath())).toBe(true);

      const resumed = await claimEnrollment(invite, "worker-changed-on-retry");
      expect(resumed).toEqual(first);
      commitEnrollment(resumed, { replaceExisting: true });
      expect(isEnrollmentPending(invite)).toBe(false);
      expect(existsSync(pendingEnrollmentPath())).toBe(false);
      expect(loadJoin()).toEqual(first);
      expect(claims).toBe(2);
      expect(idempotencyKeys.size).toBe(1);
      expect(credentialPublicKeys.size).toBe(1);
      expect(requestedNodeNames).toEqual(["worker-original", "worker-original"]);
    } finally {
      server.stop(true);
    }
  });

  test("refuses to delete pending material for different credentials from the same central", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, string>;
        return Response.json({
          ok: true,
          relayUrl: "https://relay.example",
          cell: { id: "cell_exact", baseUrl: "https://relay.example/n/cell_exact" },
          credential: seal("rcs_exact-secret", body.credentialPublicKey!),
        });
      },
    });
    try {
      const invite = {
        v: 2 as const,
        central: `http://127.0.0.1:${server.port}`,
        token: "nei_exact",
      };
      const claimed = await claimEnrollment(invite);
      const wrong = { ...claimed, secret: "rcs_different-secret" };
      expect(() => commitEnrollment(wrong, { replaceExisting: true })).toThrow("does not match");
      expect(existsSync(pendingEnrollmentPath())).toBe(true);
      expect(existsSync(joinFilePath())).toBe(false);

      commitEnrollment(claimed);
      expect(existsSync(pendingEnrollmentPath())).toBe(false);
      expect(loadJoin()).toEqual(claimed);
    } finally {
      server.stop(true);
    }
  });

  test("rejects a different credential returned for the same idempotent claim", async () => {
    let attempt = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        attempt += 1;
        const body = (await req.json()) as Record<string, string>;
        return Response.json({
          ok: true,
          relayUrl: "https://relay.example",
          cell: { id: "cell_conflict", baseUrl: "https://relay.example/n/cell_conflict" },
          credential: seal(`rcs_attempt-${attempt}`, body.credentialPublicKey!),
        });
      },
    });
    try {
      const invite = {
        v: 2 as const,
        central: `http://127.0.0.1:${server.port}`,
        token: "nei_conflict",
      };
      await claimEnrollment(invite);
      await expect(claimEnrollment(invite)).rejects.toThrow("different credentials");
      expect(existsSync(pendingEnrollmentPath())).toBe(true);
      expect(existsSync(joinFilePath())).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
