import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  issueRuntimeMcpToken,
  listApiMessages,
  NODE_CONTROL_TOKEN,
  type RuntimeMcpContext,
  registerTopic,
} from "@negotium/core";
import { startNode } from "../src/index";

test("runtime send_file stores and serves a downloadable node attachment", async () => {
  const root = mkdtempSync(join(tmpdir(), "negotium-send-file-"));
  const filePath = join(root, "delivery.txt");
  const userId = `send-file-${crypto.randomUUID()}`;
  const topic = registerTopic({
    title: `send-file-${crypto.randomUUID()}`,
    userId,
    agent: "codex",
  });
  writeFileSync(filePath, "downloadable output");
  const node = startNode({ port: 0 });
  const ctx: RuntimeMcpContext = {
    userId,
    topicId: topic.id,
    topicTitle: topic.title,
    cwd: root,
    agent: "codex",
    model: "gpt-5.6-luna",
  };
  const token = issueRuntimeMcpToken(ctx);
  const client = new Client({ name: "node-send-file-test", version: "1.0.0" });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${node.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`),
      ),
    );
    const result = await client.callTool({
      name: "send_file",
      arguments: { file_path: filePath },
    });
    expect(result.isError).toBeFalsy();

    const attachment = listApiMessages(topic.id, { limit: 10 })
      .page.flatMap((message) => message.attachments ?? [])
      .at(-1);
    expect(attachment?.filename).toBe("delivery.txt");
    const response = await fetch(`http://127.0.0.1:${node.port}${attachment?.url}`, {
      headers: { authorization: `Bearer ${NODE_CONTROL_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("downloadable output");
  } finally {
    await client.close();
    await node.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
