import { execFileSync } from "node:child_process";
import { type CodexTreeHost, createCodexTreeManager } from "#agents/codex-tree-manager";
import { logger } from "#platform/logger";

function execText(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const posixHost: CodexTreeHost = {
  parentPid: process.pid,
  getDirectChildren(parentPid) {
    const output = execText("pgrep", ["-P", String(parentPid)]);
    if (!output) return [];
    return output
      .split("\n")
      .map(Number)
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  },
  getProcessName: (pid) => execText("ps", ["-p", String(pid), "-o", "comm="]),
  getProcessStart: (pid) => execText("ps", ["-p", String(pid), "-o", "lstart="]),
  kill: (pid, signal) => process.kill(pid, signal),
  logger,
};

const manager = createCodexTreeManager(posixHost);

export type CodexProcStamp = { pid: number; lstart: string };

export const snapshotCodexChildren = manager.snapshotChildren;
export const findNewCodexChildren = manager.findNewChildren;
export const registerOwnedCodexPids = manager.registerOwnedPids;
export const unregisterOwnedCodexPids = manager.unregisterOwnedPids;
export const acquireCodexSpawnLock = manager.acquireSpawnLock;
export const withCodexSpawnSerial = manager.withSpawnSerial;
export const killCodexTrees = manager.killTrees;
export const killOwnedCodexTreesForShutdown = manager.killOwnedTreesForShutdown;

export {
  type CodexTreeHost,
  type CodexTreeLogger,
  type CodexTreeManager,
  type CodexTreeManagerOptions,
  createCodexTreeManager,
} from "#agents/codex-tree-manager";
