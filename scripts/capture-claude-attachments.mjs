#!/usr/bin/env node
/**
 * Recapture `src/agents/fixtures/claude-attachments.jsonl` from the installed
 * Claude Code.
 *
 * `writeClaudeRollout` replays this per-turn attachment chain so a
 * codex/maestro -> claude switch resumes as if the thread had always been
 * native. It is a capture of the SDK's own rollout format, so it goes stale on
 * every release that changes the chain: the previous capture was from 2.1.126
 * and current sessions emit attachment types it predates.
 *
 * Run this after upgrading Claude Code:
 *   node scripts/capture-claude-attachments.mjs
 *
 * The capture runs in a throwaway cwd with no setting sources so the recorded
 * paths and skill listing carry no local state, and only the attachment types
 * the encoder replays are kept — a live session also emits per-turn noise
 * (`total_tokens_reminder`, `date`) that would be wrong to replay on every
 * synthetic turn.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = join(
  ROOT,
  "packages",
  "core",
  "src",
  "agents",
  "fixtures",
  "claude-attachments.jsonl",
);
const PROJECTS = join(homedir(), ".claude", "projects");

/** Chain entries the encoder replays, in the order the SDK emits them. */
const WANTED = ["deferred_tools_delta", "skill_listing"];

/**
 * Mirror of `encodeClaudeCwd` in src/agents/rollout/claude.ts: the SDK maps a
 * cwd to a project directory by replacing every non-alphanumeric character.
 */
function encodeCwd(cwd) {
  const real = cwd.startsWith("/tmp/") ? cwd.replace(/^\/tmp\//, "/private/tmp/") : cwd;
  return `-${real.replaceAll(/[^a-zA-Z0-9]/g, "-").replace(/^-/, "")}`;
}

/**
 * Scoped to the capture cwd's own project directory. Scanning all of
 * ~/.claude/projects picks up whatever other session happens to be writing on
 * this machine — the first run of this script captured an unrelated live topic
 * and reproduced the very staleness it exists to fix.
 */
function newestRollout(projectDir, since) {
  if (!existsSync(projectDir)) return null;
  let best = null;
  for (const name of readdirSync(projectDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const full = join(projectDir, name);
    const m = statSync(full).mtimeMs;
    if (m >= since && (!best || m > best.mtime)) best = { path: full, mtime: m };
  }
  return best?.path ?? null;
}

// realpath: macOS hands out /var/folders/... but records /private/var/folders/...,
// and the project directory name is derived from what the SDK records.
const captureCwd = realpathSync(mkdtempSync(join(tmpdir(), "claude-attach-capture-")));
const startedAt = Date.now();
console.log("running claude to produce a fresh session...");
execFileSync(
  process.env.CLAUDE_BIN || "claude",
  [
    "--print",
    "--permission-mode",
    "bypassPermissions",
    // Without this the skill_listing enumerates whatever skills the capturing
    // machine has configured — a first run embedded the operator's private and
    // company skills. Empty sources leave only what Claude Code itself ships,
    // which is what a fixture should describe.
    "--setting-sources",
    "",
    "reply with exactly: capture",
  ],
  { cwd: captureCwd, stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 },
);

const projectDir = join(PROJECTS, encodeCwd(captureCwd));
const rollout = newestRollout(projectDir, startedAt);
if (!rollout)
  throw new Error(`capture-claude-attachments: no rollout produced under ${projectDir}`);

const entries = readFileSync(rollout, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const chain = [];
for (const wanted of WANTED) {
  const hit = entries.find((e) => e.type === "attachment" && e.attachment?.type === wanted);
  if (!hit) {
    const seen = [
      ...new Set(entries.filter((e) => e.type === "attachment").map((e) => e.attachment?.type)),
    ];
    throw new Error(
      `capture-claude-attachments: ${wanted} not found in ${rollout} (saw ${seen.join(", ") || "none"})`,
    );
  }
  chain.push(hit);
}

writeFileSync(FIXTURE, `${chain.map((e) => JSON.stringify(e)).join("\n")}\n`);
console.log(
  `wrote ${chain.length} entries to ${FIXTURE}\n` +
    `  claude ${chain[0].version}\n` +
    `  source ${rollout}`,
);
