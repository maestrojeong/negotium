import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureVaultStorage, vaultDel, vaultSet } from "#storage/vault";
// The production browser wrapper is plain ESM because it runs under Node.
import {
  createBrowserVaultTransforms,
  prepareBrowserToolInputForRedaction,
  redactBrowserToolOutputBeforeBounding,
} from "../../../scripts/browser-vault-transform.mjs";

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

  test("redacts bounded browser results before every truncation boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-browser-boundary-"));
    const dispose = configureVaultStorage({ dataDir: dir, masterKey: "boundary-test-master-key" });
    cleanups.push(() => {
      dispose();
      rmSync(dir, { recursive: true, force: true });
    });

    const userId = "browser-boundary-user";
    const secret = "unique+/ boundary?secret=value";
    vaultSet(userId, "BOUNDARY_TOKEN", secret);
    const transforms = await createBrowserVaultTransforms(userId);
    const forms = [secret, encodeURIComponent(secret)];

    for (const form of forms) {
      for (let cut = 1; cut < form.length; cut += 1) {
        const limit = 8 + cut;
        const prepared = prepareBrowserToolInputForRedaction("browser_snapshot", {
          maxLength: limit,
        });
        expect(prepared.input.maxLength).toBeGreaterThan(limit);

        const rawResult = {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                snapshot: `${"x".repeat(8)}${form} after`,
                truncated: false,
                length: 8 + form.length + 6,
              }),
            },
          ],
        };
        const secured = redactBrowserToolOutputBeforeBounding(
          rawResult,
          transforms.redact,
          prepared.boundary,
        );
        const serialized = secured.content[0]?.text ?? "";
        const parsed = JSON.parse(serialized);

        expect(parsed.snapshot.length).toBeLessThanOrEqual(limit);
        expect(parsed.truncated).toBe(true);
        expect(serialized).not.toContain(secret);
        expect(parsed.snapshot).not.toContain(form.slice(0, cut));
      }
    }
  });

  test("moves every upstream browser output limit behind redaction", () => {
    for (const [toolName, argument] of [
      ["browser_snapshot", "maxLength"],
      ["browser_api_request", "maxBytes"],
      ["browser_get_visible_text", "maxLength"],
      ["browser_get_visible_html", "maxLength"],
    ]) {
      const prepared = prepareBrowserToolInputForRedaction(toolName, { [argument]: 25 });
      expect(prepared.input[argument]).toBeGreaterThan(25);
      expect(prepared.boundary?.limit).toBe(25);
    }

    const withDefault = prepareBrowserToolInputForRedaction("browser_snapshot", {});
    expect(withDefault.input.maxLength).toBe(Number.MAX_SAFE_INTEGER);
    expect(withDefault.boundary?.limit).toBe(100_000);

    for (const invalid of [0, -1, 1.5, Number.POSITIVE_INFINITY, "25"]) {
      const input = { maxLength: invalid };
      const prepared = prepareBrowserToolInputForRedaction("browser_snapshot", input);
      expect(prepared.input).toBe(input);
      expect(prepared.boundary).toBeUndefined();
    }
  });

  test("retains substituted values across Vault rotation and deletion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-browser-retained-"));
    const dispose = configureVaultStorage({ dataDir: dir, masterKey: "retained-test-master-key" });
    cleanups.push(() => {
      dispose();
      rmSync(dir, { recursive: true, force: true });
    });

    const userId = "browser-retained-user";
    const oldSecret = 'old \\ path with "json" and\na newline';
    vaultSet(userId, "ROTATING_TOKEN", oldSecret);
    const transforms = await createBrowserVaultTransforms(userId);

    expect(transforms.substitute({ text: "{{ROTATING_TOKEN}}" })).toEqual({ text: oldSecret });
    vaultSet(userId, "ROTATING_TOKEN", "replacement secret value");
    vaultDel(userId, "ROTATING_TOKEN");

    const secured = transforms.postprocess({
      content: [
        {
          type: "text",
          text: JSON.stringify({ snapshot: `prefix ${oldSecret} suffix` }),
        },
      ],
    });
    const serialized = JSON.stringify(secured);
    const escapedOldSecret = JSON.stringify(oldSecret).slice(1, -1);
    expect(serialized).not.toContain(oldSecret);
    expect(serialized).not.toContain(escapedOldSecret);
    expect(serialized).toContain("[REDACTED:ROTATING_TOKEN]");
  });

  test("fails closed when browser output redaction throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-browser-fail-closed-"));
    const dispose = configureVaultStorage({ dataDir: dir, masterKey: "failure-test-master-key" });
    cleanups.push(() => {
      dispose();
      rmSync(dir, { recursive: true, force: true });
    });

    const transforms = await createBrowserVaultTransforms("browser-failure-user");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const secured = transforms.postprocess(cyclic);
    expect(secured).toEqual({
      content: [
        { type: "text", text: "Browser output was blocked because secure redaction failed." },
      ],
      isError: true,
    });
  });
});
