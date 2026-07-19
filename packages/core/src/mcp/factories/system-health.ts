import { execFile } from "node:child_process";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errMsg } from "#platform/error";
import { mcpOk } from "../mcp-helpers";

const execFileAsync = promisify(execFile);

export interface SystemHealthSnapshot {
  cpuLoad: [number, number, number];
  cpuCount: number;
  memoryTotal: number;
  memoryFree: number;
  memoryPressure: string;
  swap: string;
  disk: string;
  thermal: string;
  processCount: number;
}

export interface SystemHealthMcpHost {
  readSystemHealth(): Promise<SystemHealthSnapshot>;
}

function fmtBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / 1024 ** 2).toFixed(0)}MB`;
}

async function shell(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { timeout: 5_000 });
  return stdout.trim();
}

async function getMemoryPressure(): Promise<string> {
  try {
    const level = await shell("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
    return level === "4" ? "critical" : level === "2" ? "warning" : "normal";
  } catch {
    return "unknown";
  }
}

async function getSwapUsage(): Promise<string> {
  try {
    const output = await shell("sysctl", ["vm.swapusage"]);
    const match = output.match(
      /total\s*=\s*([\d.]+\w+)\s+used\s*=\s*([\d.]+\w+)\s+free\s*=\s*([\d.]+\w+)/,
    );
    return match ? `used ${match[2]} / total ${match[1]}  여유: ${match[3]}` : output;
  } catch (error) {
    return errMsg(error);
  }
}

async function getThermal(): Promise<string> {
  try {
    const output = await shell("pmset", ["-g", "therm"]);
    const cpuLimit = output.match(/CPU_Scheduler_Limit\s*=\s*(\d+)/)?.[1];
    const cpuAvailable = output.match(/CPU_Available_CPUs\s*=\s*(\d+)/)?.[1];
    const thermalLevel = output.match(/System Thermal Level\s*=\s*(\d+)/)?.[1];
    const parts: string[] = [];
    if (thermalLevel !== undefined) parts.push(`level ${thermalLevel}`);
    if (cpuLimit !== undefined) parts.push(`CPU scheduler limit ${cpuLimit}%`);
    if (cpuAvailable !== undefined) parts.push(`available CPUs ${cpuAvailable}`);
    return parts.length > 0 ? parts.join(", ") : "nominal";
  } catch (error) {
    return errMsg(error);
  }
}

async function getProcessCount(): Promise<number> {
  try {
    const output = await shell("ps", ["-A", "-o", "pid="]);
    return output.split("\n").filter(Boolean).length;
  } catch {
    return -1;
  }
}

async function getDisk(): Promise<string> {
  try {
    const output = await shell("df", ["-k", "-P", "/"]);
    const parts = output.split("\n")[1]?.split(/\s+/);
    if (!parts || parts.length < 4) return "조회 실패";
    const total = Number(parts[1]) * 1024;
    const used = Number(parts[2]) * 1024;
    const available = Number(parts[3]) * 1024;
    return `${fmtBytes(used)} / ${fmtBytes(total)} (${((used / total) * 100).toFixed(1)}%)  여유: ${fmtBytes(available)}`;
  } catch (error) {
    return errMsg(error);
  }
}

export const defaultSystemHealthMcpHost: SystemHealthMcpHost = {
  async readSystemHealth() {
    const [memoryPressure, swap, thermal, disk, processCount] = await Promise.all([
      getMemoryPressure(),
      getSwapUsage(),
      getThermal(),
      getDisk(),
      getProcessCount(),
    ]);
    const load = loadavg();
    return {
      cpuLoad: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
      cpuCount: cpus().length,
      memoryTotal: totalmem(),
      memoryFree: freemem(),
      memoryPressure,
      swap,
      disk,
      thermal,
      processCount,
    };
  },
};

export function createSystemHealthMcpServer(
  host: SystemHealthMcpHost = defaultSystemHealthMcpHost,
): McpServer {
  const server = new McpServer({ name: "system-health", version: "1.0.0" });
  server.tool(
    "get_system_health",
    [
      "시스템 상태를 조회합니다.",
      "- CPU 부하 (load average 1/5/15분)",
      "- 메모리 사용량 + 압력 (normal/warning/critical)",
      "- 스왑 사용량",
      "- 디스크 사용률 (/)",
      "- 열 상태 (thermal)",
      "- 프로세스 수",
    ].join("\n"),
    {},
    async () => {
      const snapshot = await host.readSystemHealth();
      const used = snapshot.memoryTotal - snapshot.memoryFree;
      const memoryPercent = ((used / snapshot.memoryTotal) * 100).toFixed(1);
      const [load1, load5, load15] = snapshot.cpuLoad;
      return mcpOk(
        [
          "시스템 상태",
          "",
          `CPU 부하:      ${load1.toFixed(2)} / ${load5.toFixed(2)} / ${load15.toFixed(2)}  (1/5/15분, 코어 ${snapshot.cpuCount}개)`,
          `메모리:        ${fmtBytes(used)} / ${fmtBytes(snapshot.memoryTotal)} (${memoryPercent}%)  여유: ${fmtBytes(snapshot.memoryFree)}`,
          `메모리 압력:   ${snapshot.memoryPressure}`,
          `스왑:          ${snapshot.swap}`,
          `디스크(/):     ${snapshot.disk}`,
          `열 상태:       ${snapshot.thermal}`,
          `프로세스 수:   ${snapshot.processCount > 0 ? `${snapshot.processCount}개` : "조회 실패"}`,
        ].join("\n"),
      );
    },
  );
  return server;
}
