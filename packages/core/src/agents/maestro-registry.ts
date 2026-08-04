import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentRegistry, AgentRegistryOperations } from "#agents/contracts";
import { assertUuidLike, ensureCwdExists, extractChatPairs } from "#agents/rollout/shared";
import { logger } from "#platform/logger";
import { MAESTRO_EFFORT_VALUES } from "#types";

const ALIAS_MAP: Record<string, string> = {
  "deepseek-pro": "deepseek-v4-pro",
  // "deepseek-flash" was disabled in 0.1.25 because DeepSeek had retired its
  // old flash model. "DeepSeek-V4-Flash-0731" (released 2026-07-31) is an
  // unrelated, currently-live model reusing a similar name — verified with a
  // live API call before re-enabling this alias.
  "deepseek-flash": "deepseek-v4-flash",
  kimi: "kimi-k3",
  "kimi-pro": "kimi-k3",
  "kimi-code": "kimi-k2.7-code",
};
const VALID_MODELS = new Set([...Object.keys(ALIAS_MAP), ...Object.values(ALIAS_MAP)]);
const VALID_EFFORTS = new Set(MAESTRO_EFFORT_VALUES);

export const maestroRegistry: AgentRegistry = {
  kind: "maestro",
  defaultModel: "deepseek-pro",
  defaultEffort: "medium",
  expandModelAlias(model) {
    return ALIAS_MAP[model] ?? model;
  },
  validateModel(model) {
    return VALID_MODELS.has(model);
  },
  validEfforts: MAESTRO_EFFORT_VALUES,
  validateEffort(effort) {
    return VALID_EFFORTS.has(effort);
  },
  footerLabel(model, effort) {
    return effort ? `${model} · ${effort}` : model;
  },
};

function maestroSessionsDir(): string {
  return join(
    process.env.MAESTRO_DATA_DIR
      ? resolve(process.env.MAESTRO_DATA_DIR)
      : join(homedir(), ".maestro"),
    "sessions",
  );
}

function maestroSessionPath(sessionId: string): string {
  return join(maestroSessionsDir(), `${sessionId}.jsonl`);
}

function maestroActiveSessionPath(sessionId: string): string {
  return join(maestroSessionsDir(), `${sessionId}.active.jsonl`);
}

function existingCreatedAt(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
    const parsed = JSON.parse(firstLine) as { _meta?: { createdAt?: unknown } };
    return typeof parsed._meta?.createdAt === "string" ? parsed._meta.createdAt : undefined;
  } catch {
    return undefined;
  }
}

function writeRollout(options: Parameters<AgentRegistryOperations["writeRollout"]>[0]) {
  const sessionId = options.reuseSessionId ?? randomUUID();
  assertUuidLike("sessionId", sessionId);
  ensureCwdExists(options.cwd);
  const path = maestroSessionPath(sessionId);
  mkdirSync(maestroSessionsDir(), { recursive: true });
  const messages = extractChatPairs(options.entries).flatMap((pair) => [
    { role: "user", content: pair.userText },
    { role: "assistant", content: pair.assistantText },
  ]);
  const lines = [
    {
      _meta: {
        version: 1,
        cwd: options.cwd,
        createdAt: existingCreatedAt(path) ?? new Date().toISOString(),
        sdkVersion: "0.2.0",
      },
    },
    ...messages,
  ];
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, {
    mode: 0o600,
  });
  return { sessionId, rolloutPath: path };
}

export const maestroRegistryOperations: AgentRegistryOperations = {
  writeRollout(options) {
    return writeRollout(options);
  },
  async forkSession(options) {
    // Fork the full raw history while preserving the compacted working view.
    // A compacted parent that cannot copy its active projection is not a usable
    // cache-preserving fork, so let the caller fall back to bounded synthesis.
    const { deleteMaestroSession, forkSessionAt, loadRawMaestroSession } = await import(
      "maestro-agent-sdk"
    );
    const parentMessages = loadRawMaestroSession(options.parentSessionId);
    if (!parentMessages) {
      throw new Error(`Maestro parent session not found: ${options.parentSessionId}`);
    }
    const parentHasActiveProjection = existsSync(maestroActiveSessionPath(options.parentSessionId));
    const fork = forkSessionAt({
      parentSessionId: options.parentSessionId,
      messageIndex: parentMessages.length,
      cwd: options.cwd,
      userId: String(options.userId),
    });
    if (parentHasActiveProjection && !fork.activeProjectionForked) {
      deleteMaestroSession(fork.sessionId);
      throw new Error(`Maestro active projection could not be forked: ${options.parentSessionId}`);
    }
    const activePath = maestroActiveSessionPath(fork.sessionId);
    return {
      forkId: fork.sessionId,
      rolloutPath: fork.rolloutPath,
      ...(existsSync(activePath) ? { cleanupPaths: [activePath] } : {}),
    };
  },
  async cleanupRollouts(options) {
    // Keep the SDK off the daemon startup path, but use its canonical cleanup
    // once a Maestro session is actually being removed. It also clears memory,
    // task, todo, and in-process file-state sidecars.
    const { deleteMaestroSession } = await import("maestro-agent-sdk");
    const failures: unknown[] = [];
    for (const sessionId of options.sessionIds) {
      try {
        deleteMaestroSession(sessionId);
        const remaining = [
          maestroSessionPath(sessionId),
          maestroActiveSessionPath(sessionId),
        ].filter(existsSync);
        if (remaining.length > 0) {
          throw new Error(`Maestro session files remain after cleanup: ${remaining.join(", ")}`);
        }
      } catch (error) {
        logger.warn({ err: error, sessionId }, "maestro cleanupRollouts: cleanup failed");
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Maestro rollout cleanup failed");
    }
  },
};
