// Keep the Codex SDK's child process from flashing a console window on Windows.
//
// `@openai/codex-sdk` starts codex with `spawn(executablePath, args, { env,
// signal })` and no `windowsHide`, and it exposes no way to pass one. On Windows
// that pops a console window for every Codex turn. Patching `child_process.spawn`
// does not help under Bun: the SDK's `import { spawn }` binds to the native
// builtin, so reassigning the export is never seen. What does work is rewriting
// the SDK's source as Bun loads it, so this registers a load hook that adds the
// option to that one call.
//
// This has to run before anything imports the SDK, which is why it is called
// from the bin shim ahead of the dynamic `import("../dist/main.js")`.
//
// The rewrite is anchored on the exact call shape. If a future SDK changes it the
// pattern simply does not match and the SDK loads unmodified: the window comes
// back, nothing breaks.

const SPAWN_CALL = /(spawn\(this\.executablePath, commandArgs, \{\s*env,)(?![^}]*windowsHide)/;

/** Returns the patched source, or `undefined` when the call shape is not found. */
export function patchCodexSdkSource(source) {
  if (!SPAWN_CALL.test(source)) return undefined;
  return source.replace(SPAWN_CALL, "$1 windowsHide: true,");
}

export async function hideCodexSdkWindowOnWindows() {
  if (process.platform !== "win32") return;
  const { plugin } = await import("bun");
  plugin({
    name: "codex-sdk-windows-hide",
    setup(build) {
      // `.` rather than `[\\/]` for the separators: Bun's plugin filter did not
      // match a separator character class against this Windows path.
      build.onLoad({ filter: /@openai.codex-sdk.dist.index\.js$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        return { contents: patchCodexSdkSource(source) ?? source, loader: "js" };
      });
    },
  });
}
