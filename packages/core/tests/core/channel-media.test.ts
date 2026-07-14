/**
 * Channel-adapter media surface: [FILE:] tag extraction/stripping, attachment
 * intake into the topic workspace, local transcription wrapper, and the turn
 * footer. These are the shared pieces every channel adapter (Telegram, …)
 * consumes instead of reimplementing.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFileTagPaths, stripFileTags } from "#media/file-events";
import { isTranscriptionConfigured, transcribeAudio } from "#media/text-extractor";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { composeAttachmentPrompt, ingestAttachment } from "#runtime/attachments";
import { renderTurnFooter } from "#runtime/footer";

const TMP = mkdtempSync(join(tmpdir(), "negotium-channel-media-"));

describe("[FILE:] tag helpers", () => {
  test("extractFileTagPaths returns deduped absolute paths in order", () => {
    const text =
      "Here you go [FILE:/tmp/a.pdf] and a chart [FILE:/tmp/b.png]\nagain [FILE:/tmp/a.pdf]";
    expect(extractFileTagPaths(text)).toEqual(["/tmp/a.pdf", "/tmp/b.png"]);
    expect(extractFileTagPaths("no tags here")).toEqual([]);
    expect(extractFileTagPaths("[FILE:relative/nope]")).toEqual([]); // must be absolute
  });

  test("stripFileTags removes tags and trims", () => {
    expect(stripFileTags("done [FILE:/tmp/a.pdf]")).toBe("done");
    expect(stripFileTags("[FILE:/tmp/a.pdf]")).toBe("");
    expect(stripFileTags("keep me")).toBe("keep me");
  });
});

describe("ingestAttachment", () => {
  test("stores bytes in the topic workspace uploads dir and returns the canonical prompt line", () => {
    const topicId = "channel-media-ingest-topic";
    const ingested = ingestAttachment({
      topicId,
      filename: "photo.jpg",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(ingested.path.startsWith(join(resolveTopicWorkspaceDir(topicId), "uploads"))).toBe(true);
    expect(readFileSync(ingested.path)).toEqual(Buffer.from([1, 2, 3]));
    expect(ingested.promptLine).toBe(`[Attached file: photo.jpg at path: ${ingested.path}]`);
  });

  test("copies from sourcePath and sanitizes hostile filenames", () => {
    const src = join(TMP, "src.txt");
    writeFileSync(src, "hello");
    const ingested = ingestAttachment({
      topicId: "channel-media-ingest-topic",
      filename: "../../etc/passwd",
      sourcePath: src,
    });
    expect(readFileSync(ingested.path, "utf-8")).toBe("hello");
    expect(ingested.path.includes("..")).toBe(false);
    expect(existsSync(ingested.path)).toBe(true);
  });

  test("composeAttachmentPrompt keeps user text first and falls back when empty", () => {
    expect(composeAttachmentPrompt("look at this", ["[Attached file: a at path: /x/a]"])).toBe(
      "look at this\n\n[Attached file: a at path: /x/a]",
    );
    expect(composeAttachmentPrompt("", ["[Attached file: a at path: /x/a]"])).toBe(
      "이 파일을 확인해주세요.\n\n[Attached file: a at path: /x/a]",
    );
    expect(composeAttachmentPrompt("just text", [])).toBe("just text");
  });
});

describe("transcribeAudio", () => {
  test("returns null when the pipeline is not configured", async () => {
    expect(isTranscriptionConfigured({ wrapperPath: join(TMP, "missing.py") })).toBe(false);
    const text = await transcribeAudio(join(TMP, "voice.ogg"), {
      ffmpegBin: "/usr/bin/true",
      wrapperPath: join(TMP, "missing.py"),
    });
    expect(text).toBeNull();
  });

  test("runs the wrapper and returns its transcript (token-free fake wrapper)", async () => {
    // Fake "python wrapper": a shell script that writes audio.txt into
    // --output-dir, mimicking faster-whisper-wrapper.py's contract.
    const wrapper = join(TMP, "fake-whisper.sh");
    writeFileSync(
      wrapper,
      `#!/bin/sh
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-dir" ]; then out="$a"; fi
  prev="$a"
done
printf 'fake transcript' > "$out/audio.txt"
`,
    );
    chmodSync(wrapper, 0o755);
    const voicePath = join(TMP, "voice.ogg");
    writeFileSync(voicePath, "not really audio");

    const opts = {
      ffmpegBin: "/usr/bin/true", // conversion step becomes a no-op
      pythonBin: "/bin/sh",
      wrapperPath: wrapper,
    };
    expect(isTranscriptionConfigured(opts)).toBe(true);
    expect(await transcribeAudio(voicePath, opts)).toBe("fake transcript");
  });
});

describe("renderTurnFooter", () => {
  test("joins agent/model/usage and returns null when empty", () => {
    expect(
      renderTurnFooter({
        agentType: "claude",
        model: "claude-sonnet-4",
        usage: { input: 120, output: 45 },
      }),
    ).toBe("claude · claude-sonnet-4 · ↑120 ↓45 tok");
    expect(renderTurnFooter({ agentType: "codex" })).toBe("codex");
    expect(renderTurnFooter({})).toBeNull();
  });
});
