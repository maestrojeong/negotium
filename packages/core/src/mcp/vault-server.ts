#!/usr/bin/env node
import "./stdio-protect";
import { createVaultMcpServer, type VaultMcpHost } from "#mcp/factories/vault";
import { connectStdio, parseUserIdArg } from "#mcp/mcp-helpers";
import { vaultList } from "#storage/vault";

const args = process.argv.slice(2);
const host: VaultMcpHost = {
  list: vaultList,
};

await connectStdio(createVaultMcpServer({ userId: parseUserIdArg(args) }, host));
