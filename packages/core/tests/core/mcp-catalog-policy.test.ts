import { describe, expect, test } from "bun:test";
import { COMMON_RUNTIME_MCP_POLICY, classifyForumMcpServers } from "#platform/mcp-catalog-policy";

describe("runtime MCP catalog policy", () => {
  test("keeps built-in browser and process tools required", () => {
    const classification = classifyForumMcpServers(COMMON_RUNTIME_MCP_POLICY);
    expect(classification.required).toContain("playwright");
    expect(classification.required).toContain("background-bash");
    expect(classification.optional).toEqual([]);
  });

  test("classifies host extensions without mutating common policy", () => {
    const classification = classifyForumMcpServers({
      ...COMMON_RUNTIME_MCP_POLICY,
      "host-ocr": { scopes: ["forum"] },
      "host-required": { scopes: ["forum"], forumRequired: true },
    });
    expect(classification.optional).toEqual(["host-ocr"]);
    expect(classification.required).toContain("host-required");
    expect(Object.hasOwn(COMMON_RUNTIME_MCP_POLICY, "host-ocr")).toBe(false);
  });
});
