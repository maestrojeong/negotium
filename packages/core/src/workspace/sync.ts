import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENTS_PROMPTS_DIR,
  DM_WORKSPACE_DIR,
  META_DIR,
  SESSION_WORKSPACE_DIR,
  SHARED_WIKI_DIR,
  TOPIC_WORKSPACE_DIR,
  WORKSPACE_DIR,
} from "#platform/config";
import { logger } from "#platform/logger";
import { loadAgentPrompt } from "#prompts/builders";

/**
 * Write (or merge) meta/.claude/settings.json into the given workspace's
 * .claude/settings.json. Only the hooks section from the meta template is
 * synced; any other keys in the existing file are preserved.
 */
export function syncClaudeSettings(userDir: string): void {
  const metaSettings = join(META_DIR, ".claude", "settings.json");
  if (!existsSync(metaSettings)) return;

  const template = JSON.parse(readFileSync(metaSettings, "utf-8")) as Record<string, unknown>;
  const claudeDir = join(userDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const dest = join(claudeDir, "settings.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(dest)) {
    try {
      existing = JSON.parse(readFileSync(dest, "utf-8")) as Record<string, unknown>;
    } catch {
      // corrupt JSON — start fresh
    }
  }

  const merged = { ...existing, hooks: template.hooks };
  writeFileSync(dest, `${JSON.stringify(merged, null, 2)}\n`);
}

// --- Sync helper: copy missing entries from source to target ---
function syncSkillsDir(sourceDir: string, targetDir: string, label: string, kind = "skill") {
  if (!existsSync(sourceDir)) return;
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  if (entries.length === 0) return;
  mkdirSync(targetDir, { recursive: true });
  for (const entry of entries) {
    const dest = join(targetDir, entry.name);
    if (!existsSync(dest)) {
      cpSync(join(sourceDir, entry.name), dest, { recursive: true });
      logger.info({ target: label, [kind]: entry.name }, `Synced new ${kind} from meta`);
    }
  }
}

function managedAgentWorkspaceDirs(): string[] {
  const dirs = [WORKSPACE_DIR, DM_WORKSPACE_DIR, SESSION_WORKSPACE_DIR];
  if (existsSync(TOPIC_WORKSPACE_DIR)) {
    for (const entry of readdirSync(TOPIC_WORKSPACE_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(TOPIC_WORKSPACE_DIR, entry.name));
    }
  }
  return [...new Set(dirs)];
}

export function getAutonomousAgentFiles() {
  if (!existsSync(AGENTS_PROMPTS_DIR)) return [];
  return readdirSync(AGENTS_PROMPTS_DIR, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith(".md"))
    .filter((f) => {
      try {
        return loadAgentPrompt(f.name).type === "autonomous";
      } catch {
        return false;
      }
    });
}

// --- Sync meta CLAUDE.md template to all managed agent workspaces ---
export function syncMetaClaudeMd() {
  const metaClaudeMd = join(META_DIR, "CLAUDE.md");
  if (!existsSync(metaClaudeMd)) return;
  const templateContent = readFileSync(metaClaudeMd, "utf-8");

  for (const dir of managedAgentWorkspaceDirs()) {
    const claudeMdPath = join(dir, "CLAUDE.md");
    if (!existsSync(claudeMdPath)) continue;
    const existing = readFileSync(claudeMdPath, "utf-8");
    const separatorIdx = existing.indexOf("\n---\n");
    if (separatorIdx === -1) continue;
    const userHeader = existing.slice(0, separatorIdx);
    const updated = `${userHeader}\n---\n\n${templateContent}`;
    if (updated !== existing) {
      writeFileSync(claudeMdPath, updated);
      logger.info({ workspace: dir }, "Synced meta CLAUDE.md template");
    }
  }
}

// --- Sync meta skills to the shared workspace wiki (called once at bot startup) ---
export function syncMetaSkills() {
  const metaSkillsDir = join(META_DIR, "skills");
  syncSkillsDir(metaSkillsDir, join(SHARED_WIKI_DIR, "skills"), "shared-wiki");
}

// --- Sync meta .claude/settings.json to all managed agent workspaces ---
export function syncMetaSettings(): void {
  for (const dir of managedAgentWorkspaceDirs()) {
    try {
      syncClaudeSettings(dir);
    } catch (e) {
      logger.warn({ err: e, workspace: dir }, "syncMetaSettings: failed");
    }
  }
}

// --- Sync meta agents to all managed agent workspaces (always overwrite) ---
export function syncMetaAgents() {
  const agentFiles = getAutonomousAgentFiles();
  if (agentFiles.length === 0) return;

  for (const dir of managedAgentWorkspaceDirs()) {
    const agentsDir = join(dir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    for (const agent of agentFiles) {
      cpSync(join(AGENTS_PROMPTS_DIR, agent.name), join(agentsDir, agent.name), {
        recursive: true,
      });
    }
  }
}
