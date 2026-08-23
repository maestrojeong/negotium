import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("../src/mcp-server.ts", import.meta.url));
const ROOT_TSCONFIG = fileURLToPath(new URL("../../../tsconfig.base.json", import.meta.url));

function testEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function inspectCronTools(
  transport: StdioClientTransport,
): Promise<{ names: string[]; editHasInputSchema: boolean }> {
  const client = new Client({ name: "cron-tools-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools;
    return {
      names: tools.map((tool) => tool.name),
      editHasInputSchema:
        tools.find((tool) => tool.name === "cron_edit")?.inputSchema !== undefined,
    };
  } finally {
    await client.close();
  }
}

describe("cron MCP server", () => {
  test("exposes the complete management contract", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", SERVER, "--user-id=cron-tools-test"],
      env: testEnv(),
      stderr: "pipe",
    });

    const tools = await inspectCronTools(transport);
    expect(tools.names).toEqual(
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
    expect(tools.editHasInputSchema).toBe(true);
  });

  test("starts under the Node + tsx command used by Codex", async () => {
    const env = testEnv();
    env.TSX_TSCONFIG_PATH = ROOT_TSCONFIG;
    const transport = new StdioClientTransport({
      command: "node",
      args: [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        SERVER,
        "--user-id=cron-tools-node-test",
      ],
      env,
      stderr: "pipe",
    });

    expect((await inspectCronTools(transport)).names).toEqual(
      expect.arrayContaining(["cron_create", "cron_list_scripts", "cron_list"]),
    );
  });
});
