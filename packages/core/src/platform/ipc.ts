/**
 * Local IPC endpoints that work on both a Unix-domain socket host and Windows.
 *
 * Node's local IPC is a Unix-domain socket on POSIX and a named pipe on
 * Windows, and the two differ in more than spelling: a pipe name lives in the
 * kernel's pipe namespace, not the filesystem, so it cannot be placed inside a
 * mode-0700 directory, cannot be `chmod`ed, and does not need unlinking. Route
 * endpoint construction through here so each caller states the POSIX path it
 * wants and gets a listenable address on either host.
 */

import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { basename } from "node:path";

const IS_WINDOWS = process.platform === "win32";

/**
 * Map a would-be socket path to an address `net.Server#listen` accepts here.
 *
 * On POSIX the path is returned unchanged. On Windows it becomes
 * `\\.\pipe\negotium-<label>-<digest>`, where the digest is taken over the
 * full POSIX path so two endpoints that differ only in their containing
 * directory — the usual shape, where a per-instance mkdtemp supplies the
 * uniqueness and the basename is a constant like `hook.sock` — stay distinct.
 */
export function ipcEndpoint(posixSocketPath: string): string {
  if (!IS_WINDOWS) return posixSocketPath;
  const label =
    basename(posixSocketPath)
      .replace(/\.sock$/, "")
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 48) || "endpoint";
  const digest = createHash("sha256").update(posixSocketPath).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\negotium-${label}-${digest}`;
}

/**
 * Restrict an endpoint to this user, where the platform expresses that as file
 * permissions.
 *
 * On POSIX this is the 0600 on the socket inode. Windows named pipes are not
 * filesystem objects and Node exposes no way to set their DACL, so there is
 * nothing to narrow — every caller of this module additionally authenticates
 * with a random per-instance token, which is what carries the boundary there.
 */
export function restrictIpcEndpoint(endpoint: string): void {
  if (IS_WINDOWS) return;
  chmodSync(endpoint, 0o600);
}

/** True when `endpoint` is a Windows named pipe rather than a filesystem path. */
export function isNamedPipe(endpoint: string): boolean {
  return endpoint.startsWith("\\\\.\\pipe\\") || endpoint.startsWith("\\\\?\\pipe\\");
}
