import { execFile } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errMsg } from "#platform/error";
import { mcpOk } from "../mcp-helpers";

const execFileAsync = promisify(execFile);

export interface SystemHealthMemory {
  /** 앱 실사용 (btop 방식, 회수 불가) = active + wired */
  usedBytes: number;
  /** 파일 캐시/버퍼 등 압박 시 즉시 반환 가능 = inactive + speculative + purgeable */
  cacheBytes: number;
  /** 압축된 익명 메모리 (스왑 압박 시 지표) */
  compressorBytes: number;
  /** available = total - used(active+wired) */
  availableBytes: number;
  totalBytes: number;
  /** active만 (breakdown 표시용) */
  activeBytes: number;
  /** wired만 (breakdown 표시용) */
  wiredBytes: number;
}

export interface SystemHealthMemoryPressure {
  /** normal / warning / critical / unknown */
  level: string;
  /** macOS 공식 "System-wide memory free percentage" (0~100), 없으면 null */
  freePct: number | null;
}

export interface SystemHealthSnapshot {
  cpuLoad: [number, number, number];
  cpuCount: number;
  memory: SystemHealthMemory;
  memoryPressure: SystemHealthMemoryPressure;
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

async function getMemoryPressure(): Promise<SystemHealthMemoryPressure> {
  // level: 스와핑 압박 레벨 (macOS가 실제 판정하는 공식 지표)
  let level = "unknown";
  try {
    const l = await shell("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
    level = l === "4" ? "critical" : l === "2" ? "warning" : "normal";
  } catch {
    /* keep unknown */
  }

  // freePct: `memory_pressure` 명령의 "System-wide memory free percentage"
  let freePct: number | null = null;
  try {
    const out = await shell("memory_pressure", []);
    const m = out.match(/System-wide memory free percentage:\s*(\d+)%/);
    if (m) freePct = Number(m[1]);
  } catch {
    /* keep null */
  }

  return { level, freePct };
}

async function getTotalMemBytes(): Promise<number> {
  try {
    return Number(await shell("sysctl", ["-n", "hw.memsize"]));
  } catch {
    return 0;
  }
}

async function getVmStatMemory(): Promise<SystemHealthMemory> {
  const [out, totalFromSysctl] = await Promise.all([shell("vm_stat", []), getTotalMemBytes()]);
  const extract = (label: string): number => {
    const m = out.match(new RegExp(`${label.replace(/\s/g, "\\s")}:\\s+(\\d+)`));
    return m ? Number(m[1]) : 0;
  };

  // page size를 헤더에서 동적 추출 (Apple Silicon 16384 / Intel 4096)
  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1]) || 16384;
  const pagesFree = extract("Pages free");
  const pagesActive = extract("Pages active");
  const pagesInactive = extract("Pages inactive");
  const pagesSpeculative = extract("Pages speculative");
  const pagesWired = extract("Pages wired down");
  const pagesPurgeable = extract("Pages purgeable");
  const pagesCompressor = extract("Pages occupied by compressor");

  // btop 공식: used = (active + wired). inactive/compressor/purgeable 제외.
  const activeBytes = pagesActive * pageSize;
  const wiredBytes = pagesWired * pageSize;
  const usedBytes = activeBytes + wiredBytes;
  const cacheBytes = (pagesInactive + pagesSpeculative + pagesPurgeable) * pageSize;
  const compressorBytes = pagesCompressor * pageSize;
  // total은 hw.memsize 우선 (page 합산은 부정확). 실패 시 page 합산 폴백.
  const totalBytes =
    totalFromSysctl ||
    (pagesFree +
      pagesActive +
      pagesInactive +
      pagesSpeculative +
      pagesWired +
      pagesPurgeable +
      pagesCompressor) *
      pageSize;
  const availableBytes = Math.max(0, totalBytes - usedBytes);

  return {
    usedBytes,
    cacheBytes,
    compressorBytes,
    availableBytes,
    totalBytes,
    activeBytes,
    wiredBytes,
  };
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
    const [memoryPressure, swap, thermal, disk, processCount, memory] = await Promise.all([
      getMemoryPressure(),
      getSwapUsage(),
      getThermal(),
      getDisk(),
      getProcessCount(),
      getVmStatMemory(),
    ]);
    const load = loadavg();
    return {
      cpuLoad: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
      cpuCount: cpus().length,
      memory,
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
      "- 메모리: 앱 실사용(active+wired) / 파일캐시(반환가능) / available / 압력(free%·level)",
      "- 스왑 사용량",
      "- 디스크 사용률 (/)",
      "- 열 상태 (thermal)",
      "- 프로세스 수",
      "",
      "⚠️ Chromium/playwright 등 무거운 프로세스 실행 가능 여부는 '메모리 사용%'가 아니라",
      "   메모리 압력 레벨(normal/warning/critical) + available GB 로 판단할 것.",
      "   (파일 캐시는 압박 시 즉시 반환되므로 used%에 겁먹지 말 것)",
    ].join("\n"),
    {},
    async () => {
      const snapshot = await host.readSystemHealth();
      const { memory } = snapshot;
      const usedPct =
        memory.totalBytes > 0 ? ((memory.usedBytes / memory.totalBytes) * 100).toFixed(1) : "0.0";
      const [load1, load5, load15] = snapshot.cpuLoad;
      const pressureStr =
        snapshot.memoryPressure.freePct !== null
          ? `${snapshot.memoryPressure.level} (free ${snapshot.memoryPressure.freePct}%)`
          : snapshot.memoryPressure.level;
      return mcpOk(
        [
          "시스템 상태",
          "",
          `CPU 부하:      ${load1.toFixed(2)} / ${load5.toFixed(2)} / ${load15.toFixed(2)}  (1/5/15분, 코어 ${snapshot.cpuCount}개)`,
          `메모리 실사용: ${fmtBytes(memory.usedBytes)} / ${fmtBytes(memory.totalBytes)} (${usedPct}%)  available: ${fmtBytes(memory.availableBytes)}`,
          `  (active ${fmtBytes(memory.activeBytes)} + wired ${fmtBytes(memory.wiredBytes)})`,
          `파일 캐시:     ${fmtBytes(memory.cacheBytes)} (압박 시 반환 가능)  |  압축 ${fmtBytes(memory.compressorBytes)}`,
          `메모리 압력:   ${pressureStr}`,
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
