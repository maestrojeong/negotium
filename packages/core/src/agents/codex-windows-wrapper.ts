import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The Windows stand-in for the POSIX `#!/bin/sh` codex wrapper.
 *
 * `@openai/codex-sdk` spawns `codexPathOverride` with no `shell`, and Node
 * refuses to spawn a `.cmd`/`.bat` that way (EINVAL), so the wrapper has to be
 * a real executable. It is a ~40-line C# program compiled once with the
 * `csc.exe` that ships with every Windows (.NET Framework 4), cached by source
 * hash, and copied next to a per-bridge config file for each bridge.
 *
 * It is a plain console exe (`Process.Start` with inherited stdio). A GUI-subsystem
 * variant that hides the child via CreateProcess(CREATE_NO_WINDOW) was tried and
 * rejected: antivirus flagged it as malware. The SDK spawns this without
 * windowsHide, so a console window may briefly appear per Codex turn.
 *
 * Behaviour mirrors the sh wrapper: read the private config (runtime, codex
 * script, hook socket, hook token), export the socket/token to the child, run
 * `<runtime> <codex script> [exec --dangerously-bypass-hook-trust] <args...>`
 * with inherited stdio, and return the child's exit code. Unlike `exec` on
 * POSIX there is a second process here, so the child is placed in a job object
 * with kill-on-close: when the SDK terminates the wrapper on abort the whole
 * codex tree goes with it instead of being orphaned.
 */
export const CODEX_WINDOWS_WRAPPER_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class CodexHookWrapper {
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct BASIC {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct EXTENDED {
    public BASIC Basic;
    public IO_COUNTERS Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll")]
  static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
  [DllImport("kernel32.dll")]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    int bs = 0;
    foreach (char c in a) {
      if (c == '\\') { bs++; }
      else if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; }
      else { sb.Append('\\', bs); bs = 0; sb.Append(c); }
    }
    sb.Append('\\', bs * 2);
    sb.Append('"');
    return sb.ToString();
  }

  static IntPtr KillOnCloseJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return IntPtr.Zero;
    var info = new EXTENDED();
    info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    int size = Marshal.SizeOf(typeof(EXTENDED));
    IntPtr mem = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, mem, false);
      if (!SetInformationJobObject(job, 9, mem, (uint)size)) return IntPtr.Zero;
    } finally { Marshal.FreeHGlobal(mem); }
    return job;
  }

  static int Main(string[] args) {
    string self = Process.GetCurrentProcess().MainModule.FileName;
    string[] cfg = File.ReadAllLines(Path.ChangeExtension(self, ".cfg"), Encoding.UTF8);
    if (cfg.Length < 4) { Console.Error.WriteLine("codex hook wrapper: bad config"); return 70; }
    var sb = new StringBuilder(Quote(cfg[1]));
    int i = 0;
    if (args.Length > 0 && args[0] == "exec") {
      sb.Append(" exec --dangerously-bypass-hook-trust");
      i = 1;
    }
    for (; i < args.Length; i++) sb.Append(' ').Append(Quote(args[i]));

    // No CreateNoWindow: with it the child stops inheriting our stdio handles.
    var psi = new ProcessStartInfo(cfg[0], sb.ToString());
    psi.UseShellExecute = false;
    psi.EnvironmentVariables["NEGOTIUM_CODEX_VAULT_HOOK_SOCKET"] = cfg[2];
    psi.EnvironmentVariables["NEGOTIUM_CODEX_VAULT_HOOK_TOKEN"] = cfg[3];
    IntPtr job = KillOnCloseJob();
    using (Process p = Process.Start(psi)) {
      if (job != IntPtr.Zero) AssignProcessToJobObject(job, p.Handle);
      p.WaitForExit();
      return p.ExitCode;
    }
  }
}
`;

function cscPath(): string {
  const windir = process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows";
  for (const framework of ["Framework64", "Framework"]) {
    const candidate = join(windir, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "csc.exe (.NET Framework 4) was not found, so the Codex hook wrapper cannot be built",
  );
}

/**
 * Path to the compiled wrapper, building it on first use. The cache key is the
 * source hash, so a changed wrapper is rebuilt and old copies are just ignored.
 * Compilation writes to a temp name and renames, so concurrent turns never see
 * a half-written exe.
 */
export async function ensureCodexWindowsWrapperExe(cacheDir: string): Promise<string> {
  const digest = createHash("sha256")
    .update(CODEX_WINDOWS_WRAPPER_SOURCE)
    .digest("hex")
    .slice(0, 12);
  const exePath = join(cacheDir, `codex-hook-wrapper-${digest}.exe`);
  if (existsSync(exePath)) return exePath;

  await mkdir(cacheDir, { recursive: true });
  const stamp = randomUUID();
  const sourcePath = join(cacheDir, `wrapper-${stamp}.cs`);
  const tempExe = join(cacheDir, `wrapper-${stamp}.exe`);
  try {
    await writeFile(sourcePath, CODEX_WINDOWS_WRAPPER_SOURCE, "utf8");
    await execFileAsync(
      cscPath(),
      ["/nologo", "/target:exe", "/optimize+", `/out:${tempExe}`, sourcePath],
      { windowsHide: true, timeout: 60_000 },
    );
    try {
      await rename(tempExe, exePath);
    } catch (error) {
      // Another turn finished the same build first; its exe is equivalent.
      if (!existsSync(exePath)) throw error;
    }
    return exePath;
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stdout" in error
        ? String((error as { stdout?: unknown }).stdout ?? "").trim()
        : "";
    throw new Error(
      `Failed to build the Codex hook wrapper: ${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ""}`,
    );
  } finally {
    await rm(sourcePath, { force: true });
    await rm(tempExe, { force: true });
  }
}
