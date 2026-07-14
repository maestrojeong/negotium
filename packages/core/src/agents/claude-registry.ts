import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRegistry } from "#agents/contracts";
import { encodeClaudeCwd, writeClaudeRollout } from "#agents/rollout/claude";
import { MODEL_FABLE, MODEL_OPUS, MODEL_SONNET } from "#platform/config";
import { logger } from "#platform/logger";
import { CLAUDE_EFFORT_VALUES, type EffortLevel } from "#types";

const ALIAS_MAP: Record<string, string> = {
  sonnet: MODEL_SONNET,
  opus: MODEL_OPUS,
  fable: MODEL_FABLE,
};

const VALID_ALIASES = new Set(Object.keys(ALIAS_MAP));
const VALID_EFFORTS = new Set<EffortLevel>(CLAUDE_EFFORT_VALUES);

export const claudeRegistry: AgentRegistry = {
  kind: "claude",
  defaultModel: "sonnet",
  defaultEffort: "high",

  expandModelAlias(s) {
    return ALIAS_MAP[s] ?? s;
  },

  validateModel(s) {
    return VALID_ALIASES.has(s);
  },

  validEfforts: CLAUDE_EFFORT_VALUES,
  validateEffort(s) {
    return VALID_EFFORTS.has(s);
  },

  footerLabel(model, effort) {
    return effort ? `${model} · ${effort}` : model;
  },

  writeRollout(opts) {
    // `reuseSessionId` (if any) becomes the SDK resume key + path component,
    // so claude→codex→claude lands at the original `~/.claude/projects/<dir>/<id>.jsonl`
    // instead of orphaning a fresh UUID every switch.
    const { sessionId, rolloutPath } = writeClaudeRollout({
      cwd: opts.cwd,
      entries: opts.entries,
      model: claudeRegistry.expandModelAlias(opts.model ?? claudeRegistry.defaultModel),
      ...(opts.reuseSessionId ? { sessionId: opts.reuseSessionId } : {}),
    });
    return { sessionId, rolloutPath };
  },

  // Claude has a native fork API in @anthropic-ai/claude-agent-sdk that produces
  // a byte-equivalent copy of the parent rollout. Preserves tool history
  // structurally, so the fork is indistinguishable from the parent on resume.
  //
  // SDK ≥0.3.19x semantics: `dir` is where to FIND the parent session (lookup
  // scope), NOT the destination — passing the derived topic's cwd made lookup
  // fail ("Session … not found in project directory"). The fork file is always
  // written NEXT TO the parent rollout, so after forking we move it into the
  // derived cwd's project dir where a resume from that cwd expects it.
  async forkSession({ parentSessionId, cwd, title }) {
    const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");
    // Omit `dir`: the parent session lives under the SOURCE topic's project
    // dir, which this registry never receives — global search finds it.
    const result = await forkSession(parentSessionId, {
      ...(title ? { title } : {}),
    });
    const projectsRoot = join(homedir(), ".claude", "projects");
    const destDir = join(projectsRoot, encodeClaudeCwd(cwd));
    const destPath = join(destDir, `${result.sessionId}.jsonl`);
    if (!existsSync(destPath)) {
      const sourcePath = readdirSync(projectsRoot)
        .map((d) => join(projectsRoot, d, `${result.sessionId}.jsonl`))
        .find((p) => existsSync(p));
      if (!sourcePath) {
        throw new Error(
          `claude forkSession: fork rollout ${result.sessionId}.jsonl not found under ${projectsRoot}`,
        );
      }
      mkdirSync(destDir, { recursive: true });
      renameSync(sourcePath, destPath);
    }
    return {
      forkId: result.sessionId,
      // Same project-dir layout as cleanupRollouts below — NOT under
      // `cwd/.claude/sessions/`. A wrong path here makes cleanupAgentFork's
      // existsSync always false, so silent-fork rollouts accumulate forever.
      rolloutPath: destPath,
    };
  },

  // Each Claude rollout lives at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
  // The encoded-cwd is deterministic so we can compute the path directly
  // without globbing — fast and robust against the SDK changing date layout.
  async cleanupRollouts({ cwd, sessionIds }) {
    const projectsDir = join(homedir(), ".claude", "projects", encodeClaudeCwd(cwd));
    const failures: unknown[] = [];
    for (const sid of sessionIds) {
      const path = join(projectsDir, `${sid}.jsonl`);
      try {
        unlinkSync(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
          logger.warn({ err: e, path }, "claude cleanupRollouts: unlink failed");
          failures.push(e);
        }
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "claude cleanupRollouts failed");
    }
  },
};
