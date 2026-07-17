import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("../src/mcp-server.ts", import.meta.url));

describe("cron MCP server", () => {
  test("exposes the complete management contract", async () => {
    const client = new Client({ name: "cron-tools-test", version: "1.0.0" });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", SERVER, "--user-id=cron-tools-test"],
      env,
      stderr: "pipe",
    });

    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "cron_create",
          "cron_edit",
          "cron_list_scripts",
          "cron_list",
          "cron_inspect",
          "cron_logs",
          "cron_pause",
          "cron_resume",
          "cron_restart",
          "cron_run",
          "cron_reset",
          "cron_kill",
          "cron_delete",
          "cron_status",
          "cron_reconcile",
        ]),
      );
      expect(tools.find((tool) => tool.name === "cron_edit")?.inputSchema).toBeDefined();
    } finally {
      await client.close();
    }
  });
});
