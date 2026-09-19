import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCodexWindowsWrapperExe } from "#agents/codex-windows-wrapper";

/**
 * The wrapper is a compiled C# program, so these only run where `csc.exe`
 * exists (Windows). They pin the two things the SDK depends on: the flag is
 * injected for `exec` only, and arguments -- including quotes and backslashes,
 * which the SDK's `--config` values contain -- reach codex unchanged.
 */
describe.skipIf(process.platform !== "win32")("Codex Windows hook wrapper", () => {
  async function run(args: string[]) {
    const root = mkdtempSync(join(tmpdir(), "negotium-wrapper-test-"));
    try {
      const exe = await ensureCodexWindowsWrapperExe(join(root, "cache"));
      const wrapper = join(root, "codex-with-hooks.exe");
      copyFileSync(exe, wrapper);
      const script = join(root, "fake-codex.mjs");
      writeFileSync(
        script,
        `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), socket: process.env.NEGOTIUM_CODEX_VAULT_HOOK_SOCKET, token: process.env.NEGOTIUM_CODEX_VAULT_HOOK_TOKEN }));
process.exit(Number(process.env.FAKE_EXIT ?? 0));`,
      );
      writeFileSync(
        join(root, "codex-with-hooks.cfg"),
        [process.execPath, script, "pipe-name", "tok-123"].join("\n"),
      );
      const child = spawn(wrapper, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, FAKE_EXIT: "3" },
      });
      child.stdin.end();
      const stdout = await new Response(child.stdout as unknown as ReadableStream).text();
      const exitCode = await new Promise<number | null>((resolve) =>
        child.once("exit", (code) => resolve(code)),
      );
      return {
        exitCode,
        out: JSON.parse(stdout) as { argv: string[]; socket: string; token: string },
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("injects the hook-trust flag for `exec` and exports the capability", async () => {
    const { exitCode, out } = await run(["exec", "--json", "-"]);
    expect(out.argv).toEqual(["exec", "--dangerously-bypass-hook-trust", "--json", "-"]);
    expect(out.socket).toBe("pipe-name");
    expect(out.token).toBe("tok-123");
    expect(exitCode).toBe(3);
  });

  test("leaves non-exec invocations untouched", async () => {
    const { out } = await run(["--version"]);
    expect(out.argv).toEqual(["--version"]);
  });

  test("passes quotes, spaces and trailing backslashes through unchanged", async () => {
    const tricky = ['hooks={a="b c"}', "C:\\path with space\\", 'say "hi"', "", "plain"];
    const { out } = await run(["exec", ...tricky]);
    expect(out.argv).toEqual(["exec", "--dangerously-bypass-hook-trust", ...tricky]);
  });
});
