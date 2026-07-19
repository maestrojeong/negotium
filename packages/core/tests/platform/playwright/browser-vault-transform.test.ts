import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureVaultStorage, vaultSet } from "#storage/vault";
// The production browser wrapper is plain ESM because it runs under Node.
import { createBrowserVaultTransforms } from "../../../scripts/browser-vault-transform.mjs";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("browser Vault transforms", () => {
  test("substitutes nested browser input and redacts browser output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-browser-vault-"));
    const dispose = configureVaultStorage({ dataDir: dir, masterKey: "browser-test-master-key" });
    cleanups.push(() => {
      dispose();
      rmSync(dir, { recursive: true, force: true });
    });

    const userId = "browser-user";
    const secret = "gmail-secret-value";
    vaultSet(userId, "GMAIL_PASSWORD", secret);
    const transforms = await createBrowserVaultTransforms(userId);

    expect(
      transforms.substitute({ element: "Password", value: "{{GMAIL_PASSWORD}}", nested: ["x"] }),
    ).toEqual({ element: "Password", value: secret, nested: ["x"] });
    expect(transforms.redact({ content: `filled ${secret}` })).toEqual({
      content: "filled [REDACTED:GMAIL_PASSWORD]",
    });
  });
});
