#!/usr/bin/env node
import "./stdio-protect";
import { createVaultMcpServer, type VaultCredentialHost } from "#mcp/factories/vault";
import { connectStdio, parseUserIdArg } from "#mcp/mcp-helpers";
import { logger } from "#platform/logger";
import { redactVaultSecrets, vaultList, vaultSubstituteDetailed } from "#storage/vault";

const args = process.argv.slice(2);
const host: VaultCredentialHost = {
  list: vaultList,
  substitute: vaultSubstituteDetailed,
  redact: redactVaultSecrets,
  log(level, details, message) {
    logger[level](details, message);
  },
};

await connectStdio(
  createVaultMcpServer(
    {
      userId: parseUserIdArg(args),
      listOnly: args.includes("--list-only=true"),
      httpOnly: args.includes("--http-only=true"),
      cwd: process.cwd(),
    },
    host,
  ),
);
