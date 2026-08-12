import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVaultMcpServer, type VaultMcpHost } from "#mcp/factories/vault";

function host(key: string): VaultMcpHost {
  return {
    list: () => [{ key, description: `${key} description` }],
  };
}

async function connect(server: ReturnType<typeof createVaultMcpServer>): Promise<Client> {
  const client = new Client({ name: "vault-factory-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("createVaultMcpServer", () => {
  test("keeps caller-owned hosts isolated", async () => {
    const alphaServer = createVaultMcpServer({ userId: "same-user" }, host("ALPHA"));
    const betaServer = createVaultMcpServer({ userId: "same-user" }, host("BETA"));
    const alpha = await connect(alphaServer);
    const beta = await connect(betaServer);
    try {
      const alphaResult = await alpha.callTool({
        name: "vault_list",
        arguments: {},
      });
      const betaResult = await beta.callTool({
        name: "vault_list",
        arguments: {},
      });
      expect(JSON.stringify(alphaResult)).toContain("ALPHA");
      expect(JSON.stringify(alphaResult)).not.toContain("BETA");
      expect(JSON.stringify(betaResult)).toContain("BETA");
      expect(JSON.stringify(betaResult)).not.toContain("ALPHA");
    } finally {
      await alpha.close();
      await beta.close();
      await alphaServer.close();
      await betaServer.close();
    }
  });

  test("offers only key discovery", async () => {
    const server = createVaultMcpServer({ userId: "user" }, host("TOKEN"));
    const client = await connect(server);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["vault_list"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
