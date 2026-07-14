import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FFMPEG_BIN, FFPROBE_BIN } from "#platform/config";
import { logger } from "#platform/logger";

const FFMPEG = FFMPEG_BIN ?? "ffmpeg";
const FFPROBE = FFPROBE_BIN ?? "ffprobe";

interface VideoPreview {
  thumbnail: string | null; // path to single thumbnail image
  duration: number; // seconds
  outputDir: string; // dir for agent to use for further extraction
}

/** Get video duration in seconds */
function getDurationSeconds(videoPath: string): number {
  try {
    const out = execFileSync(
      FFPROBE,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      { encoding: "utf-8" },
    ).trim();
    return parseFloat(out) || 0;
  } catch (err) {
    logger.warn({ err, videoPath }, "video: Failed to get duration");
    return 0;
  }
}

/** Extract single thumbnail from ~30% point of video */
function extractThumbnail(videoPath: string, outputDir: string, duration: number): string | null {
  const timestamp = duration * 0.3;
  const outFile = join(outputDir, "thumbnail.jpg");
  try {
    execFileSync(
      FFMPEG,
      ["-y", "-ss", timestamp.toFixed(2), "-i", videoPath, "-vframes", "1", "-q:v", "2", outFile],
      { timeout: 15000, stdio: "pipe" },
    );
    return existsSync(outFile) ? outFile : null;
  } catch (err) {
    logger.warn({ err, videoPath, outputDir }, "video: Failed to extract thumbnail");
    return null;
  }
}

/** Lightweight video preview: 1 thumbnail only. Agent handles the rest via skill. */
export async function previewVideo(videoPath: string, uploadDir: string): Promise<VideoPreview> {
  const baseName =
    videoPath
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") || "video";
  const outputDir = join(uploadDir, `${baseName}_analysis`);
  mkdirSync(outputDir, { recursive: true });

  const duration = getDurationSeconds(videoPath);
  const thumbnail = duration > 0 ? extractThumbnail(videoPath, outputDir, duration) : null;

  return { thumbnail, duration, outputDir };
}

/** Build prompt text for the video */
export function buildVideoPrompt(videoPath: string, preview: VideoPreview): string {
  const fileName = videoPath.split("/").pop() || "video";
  const lines: string[] = [];

  lines.push(`[Attached video: ${fileName} at path: ${videoPath}]`);
  lines.push(
    `(영상 길이: ${Math.round(preview.duration)}초, 분석용 디렉토리: ${preview.outputDir})`,
  );

  if (preview.thumbnail) {
    lines.push(`\n미리보기 프레임 1장:`);
    lines.push(`[Attached file: thumbnail.jpg at path: ${preview.thumbnail}]`);
  }

  lines.push(`\n⚠️ 동영상입니다. video-understanding 스킬을 참고하여 분석해주세요.`);
  lines.push(`1단계: whisper로 음성 변환 → 텍스트 문맥 교정`);
  lines.push(`2단계: 텍스트 기반으로 핵심 장면 타이밍에 ffmpeg 프레임 추출`);

  return lines.join("\n");
}
