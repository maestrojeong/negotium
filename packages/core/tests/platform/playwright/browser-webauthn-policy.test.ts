import { describe, expect, test } from "bun:test";
import { createBrowserWebAuthnGuard } from "../../../scripts/browser-webauthn-policy.mjs";

describe("browser WebAuthn policy", () => {
  test("installs once before page tools without starting for status", async () => {
    let installs = 0;
    let pages = 0;
    const context = { credentials: { install: async () => installs++ } };
    const manager = {
      getPage: async () => {
        pages++;
        return { context: () => context };
      },
    };
    const guard = createBrowserWebAuthnGuard();

    await guard.beforeTool("browser_status", manager);
    expect(pages).toBe(0);
    await guard.beforeTool("browser_navigate", manager);
    await guard.beforeTool("browser_click", manager);
    expect(installs).toBe(1);
  });

  test("installs after browser_start creates the context", async () => {
    let installs = 0;
    const context = { credentials: { install: async () => installs++ } };
    const manager = { getPage: async () => ({ context: () => context }) };
    const guard = createBrowserWebAuthnGuard();

    await guard.beforeTool("browser_start", manager);
    expect(installs).toBe(0);
    await guard.afterTool("browser_start", manager);
    expect(installs).toBe(1);
  });
});
