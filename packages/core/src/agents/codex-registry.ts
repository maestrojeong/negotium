import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { forkCodexSession } from "#agents/codex-app-server";
import type { AgentRegistry, AgentRegistryOperations } from "#agents/contracts";
import { hostedCodexHomePath } from "#agents/execution-host";
import { writeCodexRollout } from "#agents/rollout/codex";
import { logger } from "#platform/logger";
import { CODEX_EFFORT_VALUES, type EffortLevel } from "#types";

const VALID_EFFORTS = new Set<EffortLevel>(CODEX_EFFORT_VALUES);

// Codex CLI's own empirical default is gpt-5.6-sol (`codex exec` 2026-07-10 →
// "model: gpt-5.6-sol"), but we deliberately default to gpt-5.6-luna — the
// cheapest/fastest GPT-5.6 tier — for a general always-on assistant where most
// queries are light. Heavier work escalates to terra/sol via set_model. This
// value is passed explicitly to the SDK (see event-processor resolveDefaultModel),
// so the footer and the actual model stay in sync.
export const codexRegistry: AgentRegistry = {
  kind: "codex",
  defaultModel: "gpt-5.6-luna",
  // defaultEffort intentionally omitted — Codex SDK treats absence as
  // "reasoning off". Setting "high"/etc. would silently flip on reasoning.

  expandModelAlias(s) {
    return s;
  },

  validateModel(s) {
    // Codex doesn't publish a closed model list and OpenAI ships new IDs
    // (gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, o3, ...) frequently. Best-effort: accept any
    // non-empty string. Bad IDs surface at SDK call time with a clear error.
    return typeof s === "string" && s.length > 0;
  },

  validEfforts: CODEX_EFFORT_VALUES,
  validateEffort(s) {
    // GPT-5.6 accepts low/medium/high/xhigh/max; 'minimal'
    // was removed because the Codex API rejects it when default tools
    // (image_gen, web_search) are active.
    return VALID_EFFORTS.has(s);
  },

  footerLabel(model, effort) {
    // Codex omits effort to mean "reasoning off". Show `(off)` explicitly so
    // the user can distinguish from claude (which always has a default).
    return `${model} · ${effort ?? "(off)"}`;
  },
};

export const codexRegistryOperations: AgentRegistryOperations = {
  writeRollout(opts) {
    // Codex SDK exposes the resume key as `threadId`; AgentRegistry unifies
    // the name to `sessionId` so callers don't branch on agent.
    // `reuseSessionId` (if any) is forwarded as `threadId` so claude→codex→claude
    // round-trips also keep one continuous codex thread instead of orphaning a
    // fresh uuidv7 on every switch.
    const { threadId, rolloutPath } = writeCodexRollout({
      cwd: opts.cwd,
      entries: opts.entries,
      model: opts.model ?? codexRegistry.defaultModel,
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.reuseSessionId ? { threadId: opts.reuseSessionId } : {}),
    });
    return { sessionId: threadId, rolloutPath };
  },

  // The TypeScript SDK does not expose forking yet, but the bundled Codex App
  // Server does. Native thread/fork preserves the provider's stored prefix,
  // including tool structure, which gives prompt caching the best chance to
  // reuse the parent context. Callers retain unified-log synthesis as fallback.
  async forkSession({ parentSessionId }) {
    return await forkCodexSession(parentSessionId);
  },

  // Codex stores rollouts at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<threadId>.jsonl`.
  // The date prefix is unknown at cleanup time (it's the *original* write
  // timestamp, not "now"), so we glob across the whole sessions tree by
  // threadId suffix. With at most a few thousand files in active use this
  // is well under a millisecond on a warm filesystem.
  async cleanupRollouts({ sessionIds }) {
    if (sessionIds.length === 0) return;
    const sessionsDir = join(hostedCodexHomePath(), "sessions");
    // No sessions directory means there are no provider rollouts left to remove.
    if (!existsSync(sessionsDir)) return;
    const failures: unknown[] = [];
    // One Glob per threadId so a single corrupt entry can't poison the rest.
    // Bun.Glob's `scan` yields paths relative to its base dir.
    for (const tid of sessionIds) {
      try {
        const glob = new Bun.Glob(`**/rollout-*-${tid}.jsonl`);
        for await (const rel of glob.scan({ cwd: sessionsDir, onlyFiles: true })) {
          const path = join(sessionsDir, rel);
          try {
            unlinkSync(path);
          } catch (e) {
            if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
              logger.warn({ err: e, path }, "codex cleanupRollouts: unlink failed");
              failures.push(e);
            }
          }
        }
      } catch (e) {
        logger.warn({ err: e, threadId: tid }, "codex cleanupRollouts: scan failed");
        failures.push(e);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "codex cleanupRollouts failed");
    }
  },
};
