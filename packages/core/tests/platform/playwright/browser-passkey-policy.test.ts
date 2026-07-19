import { describe, expect, test } from "bun:test";
import {
  secureBrowserToolCatalog,
  secureBrowserToolInput,
  secureBrowserToolOutput,
} from "../../../scripts/browser-passkey-policy.mjs";

describe("browser passkey policy", () => {
  test("hides private-key export controls from the agent-facing catalog", () => {
    const source = [
      {
        name: "browser_passkey_list",
        description: "List passkeys. Private keys are omitted unless includePrivateKey=true.",
        inputSchema: {
          type: "object",
          properties: { rpId: { type: "string" }, includePrivateKey: { type: "boolean" } },
        },
      },
    ];

    const secured = secureBrowserToolCatalog(source);
    expect(secured[0]?.inputSchema.properties.includePrivateKey).toBeUndefined();
    expect(secured[0]?.description).toContain("never returned to the agent");
    expect(source[0]?.inputSchema.properties.includePrivateKey).toBeDefined();
  });

  test("forces export off and strips unexpected private keys from passkey results", () => {
    expect(
      secureBrowserToolInput("browser_passkey_create", {
        rpId: "example.com",
        includePrivateKey: true,
      }),
    ).toEqual({ rpId: "example.com", includePrivateKey: false });
    expect(
      secureBrowserToolOutput("browser_passkey_list", {
        credentials: [{ id: "credential", privateKey: "secret", nested: { privateKey: "secret" } }],
      }),
    ).toEqual({ credentials: [{ id: "credential", nested: {} }] });
  });

  test("leaves unrelated tools untouched", () => {
    const input = { includePrivateKey: true };
    const output = { privateKey: "page-data" };
    expect(secureBrowserToolInput("browser_evaluate", input)).toBe(input);
    expect(secureBrowserToolOutput("browser_evaluate", output)).toBe(output);
  });
});
