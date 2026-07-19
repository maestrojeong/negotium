import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Bucket, calcCost, getStats } from "#storage/token-stats";

export interface TokenStatsMcpContext {
  userId: string;
}

export interface TokenStatsSnapshot {
  total: Bucket;
  byHour: Record<string, Bucket>;
  bySession: Record<string, Bucket>;
  estimatedCostUsd: number;
}

export interface TokenStatsMcpHost {
  getStats(userId: string, from?: string, to?: string): TokenStatsSnapshot;
  calcCost(
    bucket: Pick<
      Bucket,
      "inputTokens" | "outputTokens" | "cacheCreationInputTokens" | "cacheReadInputTokens"
    >,
  ): number;
  extraSummaryLines?(userId: string): readonly string[];
}

export const defaultTokenStatsMcpHost: TokenStatsMcpHost = {
  getStats,
  calcCost,
};

export function createTokenStatsMcpServer(
  context: TokenStatsMcpContext,
  host: TokenStatsMcpHost = defaultTokenStatsMcpHost,
): McpServer {
  if (!context.userId) throw new Error("token-stats MCP requires userId");
  const server = new McpServer({ name: "token-stats", version: "1.0.0" });
  server.tool(
    "get_usage_stats",
    [
      "Claude 사용량 통계를 조회합니다. 완료된 쿼리마다 세션/시간 정보가 기록됩니다. 현재 실행 중인 turn은 완료 후 집계됩니다.",
      "",
      "from/to 생략 시 전체 기간. 자연어 시간 표현을 ISO 형식으로 변환해서 넘겨주세요.",
      "  예: '지난 3시간' → from = 현재 -3h",
      "  예: '오늘 오전' → from = 오늘 00:00Z, to = 오늘 12:00Z",
      "  예: '어제' → from = 어제 00:00Z, to = 어제 23:59Z",
      "",
      "groupBy: 'session'으로 설정하면 세션별 토큰 사용량 랭킹을 반환합니다.",
    ].join("\n"),
    {
      from: z.string().optional().describe("시작 시각 ISO 8601. 예: '2026-03-28T09:00:00Z'"),
      to: z.string().optional().describe("종료 시각 ISO 8601. 생략 시 현재"),
      groupBy: z.enum(["hour", "session"]).optional().describe("집계 기준. 기본값: hour"),
    },
    async ({ from, to, groupBy = "hour" }) => {
      const { total, byHour, bySession, estimatedCostUsd } = host.getStats(
        context.userId,
        from,
        to,
      );
      const lines: string[] = [
        "📊 Claude 사용량",
        from || to ? `기간: ${from ?? "전체"} ~ ${to ?? "현재"}` : "기간: 전체",
        "",
        `쿼리 횟수: ${total.queries.toLocaleString()}회`,
        `입력 토큰: ${total.inputTokens.toLocaleString()}`,
        `출력 토큰: ${total.outputTokens.toLocaleString()}`,
        `캐시 쓰기: ${total.cacheCreationInputTokens.toLocaleString()}`,
        `캐시 읽기: ${total.cacheReadInputTokens.toLocaleString()}`,
        `예상 비용: $${estimatedCostUsd.toFixed(4)} USD`,
      ];
      const extraSummaryLines = host.extraSummaryLines?.(context.userId) ?? [];
      if (extraSummaryLines.length > 0) lines.push("", ...extraSummaryLines);

      if (groupBy === "session") {
        const sorted = Object.entries(bySession)
          .map(([name, bucket]) => ({ name, ...bucket, cost: host.calcCost(bucket) }))
          .sort((left, right) => right.cost - left.cost);
        lines.push("", `🗂 세션별 사용량 (${sorted.length}개)`);
        for (const session of sorted) {
          lines.push(
            `  ${session.name}  쿼리 ${session.queries}회  입력 ${session.inputTokens.toLocaleString()} / 출력 ${session.outputTokens.toLocaleString()}  $${session.cost.toFixed(4)}`,
          );
        }
      } else {
        const hours = Object.keys(byHour).sort();
        if (hours.length > 0 && hours.length <= 72) {
          lines.push("", "📅 시간별 현황");
          for (const hour of hours) {
            const bucket = byHour[hour];
            if (bucket.queries === 0) continue;
            lines.push(
              `  ${hour}  쿼리 ${bucket.queries}회  입력 ${bucket.inputTokens.toLocaleString()} / 출력 ${bucket.outputTokens.toLocaleString()}  $${host.calcCost(bucket).toFixed(4)}`,
            );
          }
        } else if (hours.length > 72) {
          const byDate: Record<
            string,
            { queries: number; inputTokens: number; outputTokens: number; cost: number }
          > = {};
          for (const hour of hours) {
            const date = hour.slice(0, 10);
            byDate[date] ??= { queries: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
            const bucket = byHour[hour];
            byDate[date].queries += bucket.queries;
            byDate[date].inputTokens += bucket.inputTokens;
            byDate[date].outputTokens += bucket.outputTokens;
            byDate[date].cost += host.calcCost(bucket);
          }
          lines.push("", `📅 일별 현황 (${Object.keys(byDate).length}일)`);
          for (const [date, bucket] of Object.entries(byDate).sort()) {
            lines.push(
              `  ${date}  쿼리 ${bucket.queries}회  입력 ${bucket.inputTokens.toLocaleString()} / 출력 ${bucket.outputTokens.toLocaleString()}  $${bucket.cost.toFixed(4)}`,
            );
          }
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
  return server;
}
