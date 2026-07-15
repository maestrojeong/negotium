export const MAX_CLIPBOARD_BYTES = 100_000;

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let output = "";
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character);
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

export function osc52Sequence(value: string): string {
  const text = truncateUtf8(value, MAX_CLIPBOARD_BYTES);
  return `\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`;
}

async function pipeTo(command: string, args: string[], value: string): Promise<boolean> {
  try {
    const child = Bun.spawn([command, ...args], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.stdin.write(value);
    child.stdin.end();
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

export interface ClipboardCopyResult {
  method: "native" | "tmux" | "osc52";
  truncated: boolean;
}

/** Prefer an OS clipboard command, then tmux, and finally terminal OSC52. */
export async function copyToClipboard(
  value: string,
  write: (sequence: string) => void = (sequence) => process.stdout.write(sequence),
): Promise<ClipboardCopyResult> {
  const text = truncateUtf8(value, MAX_CLIPBOARD_BYTES);
  const truncated = text !== value;
  const nativeCandidates: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip.exe", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
            ["clip.exe", []],
          ];
  for (const [command, args] of nativeCandidates) {
    const executable = Bun.which(command);
    if (executable && (await pipeTo(executable, args, text))) {
      return { method: "native", truncated };
    }
  }
  const tmux = process.env.TMUX ? Bun.which("tmux") : null;
  if (tmux && (await pipeTo(tmux, ["load-buffer", "-"], text))) {
    return { method: "tmux", truncated };
  }
  write(osc52Sequence(text));
  return { method: "osc52", truncated };
}
