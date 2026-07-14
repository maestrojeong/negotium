#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connectStdio, parseUserIdArg } from "#mcp/mcp-helpers";
import { calcCost, getStats } from "#storage/token-stats";

const args = process.argv.slice(2);
const userId = parseUserIdArg(args);
if (!userId) {
  process.stderr.write("token-stats-server: --user-id is required (decimal integer)\n");
  process.exit(1);
}

const server = new McpServer({ name: "token-stats", version: "1.0.0" });

server.tool(
  "get_usage_stats",
  [
    "Claude 사용량 통계를 조회합니다. 쿼리마다 세션/시간 정보가 기록되어 있습니다.",
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
    const { total, byHour, bySession, estimatedCostUsd } = getStats(userId, from, to);

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

    if (groupBy === "session") {
      const sorted = Object.entries(bySession)
        .map(([name, b]) => ({ name, ...b, cost: calcCost(b) }))
        .sort((a, b) => b.cost - a.cost);

      lines.push("", `🗂 세션별 사용량 (${sorted.length}개)`);
      for (const s of sorted) {
        lines.push(
          `  ${s.name}  쿼리 ${s.queries}회  입력 ${s.inputTokens.toLocaleString()} / 출력 ${s.outputTokens.toLocaleString()}  $${s.cost.toFixed(4)}`,
        );
      }
    } else {
      const hours = Object.keys(byHour).sort();
      if (hours.length > 0 && hours.length <= 72) {
        lines.push("", "📅 시간별 현황");
        for (const h of hours) {
          const b = byHour[h];
          if (b.queries === 0) continue;
          lines.push(
            `  ${h}  쿼리 ${b.queries}회  입력 ${b.inputTokens.toLocaleString()} / 출력 ${b.outputTokens.toLocaleString()}  $${calcCost(b).toFixed(4)}`,
          );
        }
      } else if (hours.length > 72) {
        const byDate: Record<
          string,
          { queries: number; inputTokens: number; outputTokens: number; cost: number }
        > = {};
        for (const h of hours) {
          const date = h.slice(0, 10);
          if (!byDate[date])
            byDate[date] = { queries: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
          const b = byHour[h];
          byDate[date].queries += b.queries;
          byDate[date].inputTokens += b.inputTokens;
          byDate[date].outputTokens += b.outputTokens;
          byDate[date].cost += calcCost(b);
        }
        lines.push("", `📅 일별 현황 (${Object.keys(byDate).length}일)`);
        for (const [date, d] of Object.entries(byDate).sort()) {
          lines.push(
            `  ${date}  쿼리 ${d.queries}회  입력 ${d.inputTokens.toLocaleString()} / 출력 ${d.outputTokens.toLocaleString()}  $${d.cost.toFixed(4)}`,
          );
        }
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

await connectStdio(server);
