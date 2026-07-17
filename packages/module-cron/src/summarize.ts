import { logger } from "@negotium/core";
import { updateCronJobSummaryIfPromptMatches } from "#store";

const DEFAULT_URL = "https://api.deepseek.com/v1/chat/completions";
const DEFAULT_MODEL = "deepseek-chat";
const MAX_SUMMARY_LENGTH = 60;
const MAX_CONCURRENT_SUMMARIES = 3;

export type CronPromptSummarizer = (prompt: string) => Promise<string | null>;

export function cleanCronPromptSummary(raw: string): string | null {
  let text = raw.replace(/\s+/g, " ").trim();
  text = text.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  text = text.replace(/^(task|summary|label|요약|작업)\s*[:：]\s*/i, "").trim();
  text = text.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  text = text.replace(/[.。]+$/, "").trim();
  if (!text) return null;
  return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH - 3)}...` : text;
}

export async function summarizeCronPrompt(prompt: string): Promise<string | null> {
  const clean = prompt.trim();
  const apiKey = process.env.NEGOTIUM_CRON_SUMMARY_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  if (!clean || !apiKey) return null;

  const controller = new AbortController();
  const timeoutMs = Number.parseInt(process.env.NEGOTIUM_CRON_SUMMARY_TIMEOUT_MS ?? "8000", 10);
  const timer = setTimeout(
    () => controller.abort(),
    Number.isFinite(timeoutMs) ? timeoutMs : 8_000,
  );
  try {
    const response = await fetch(process.env.NEGOTIUM_CRON_SUMMARY_URL ?? DEFAULT_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.NEGOTIUM_CRON_SUMMARY_MODEL ?? DEFAULT_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Label the scheduled task in the instruction's language using at most 8 words. " +
              "Describe the outcome only. Return no quotes, prefix, or trailing period.",
          },
          { role: "user", content: clean.slice(0, 4_000) },
        ],
        max_tokens: 512,
        temperature: 0.2,
        stream: false,
      }),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, "cron: prompt summary request failed");
      return null;
    }
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return cleanCronPromptSummary(body.choices?.[0]?.message?.content ?? "");
  } catch (error) {
    logger.warn({ err: error }, "cron: prompt summary request errored");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface PendingSummary {
  jobId: string;
  prompt: string;
  generation: number;
  summarize: CronPromptSummarizer;
}

const generations = new Map<string, number>();
const pending: PendingSummary[] = [];
let active = 0;
let nextGeneration = 0;

function drain(): void {
  while (active < MAX_CONCURRENT_SUMMARIES) {
    const next = pending.shift();
    if (!next) return;
    if (generations.get(next.jobId) !== next.generation) continue;
    active += 1;
    void next
      .summarize(next.prompt)
      .then((summary) => {
        if (summary && generations.get(next.jobId) === next.generation) {
          updateCronJobSummaryIfPromptMatches(next.jobId, next.prompt, summary);
        }
      })
      .catch((error) =>
        logger.warn({ err: error, jobId: next.jobId }, "cron: summary persist failed"),
      )
      .finally(() => {
        active -= 1;
        if (generations.get(next.jobId) === next.generation) generations.delete(next.jobId);
        drain();
      });
  }
}

export function queueCronPromptSummary(
  jobId: string,
  prompt: string,
  summarize: CronPromptSummarizer = summarizeCronPrompt,
): void {
  const generation = ++nextGeneration;
  generations.set(jobId, generation);
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (pending[index]?.jobId === jobId) pending.splice(index, 1);
  }
  pending.push({ jobId, prompt, generation, summarize });
  drain();
}
