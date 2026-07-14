#!/usr/bin/env node
import { execFile } from "node:child_process";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errMsg } from "#platform/error";
import { connectStdio, mcpOk } from "./mcp-helpers";

const execFileAsync = promisify(execFile);

function fmtBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / 1024 ** 2).toFixed(0)}MB`;
}

async function shell(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
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
    const out = await shell("sysctl", ["vm.swapusage"]);
    // vm.swapusage: total = 2048.00M  used = 606.00M  free = 1442.00M
    const m = out.match(
      /total\s*=\s*([\d.]+\w+)\s+used\s*=\s*([\d.]+\w+)\s+free\s*=\s*([\d.]+\w+)/,
    );
    return m ? `used ${m[2]} / total ${m[1]}  여유: ${m[3]}` : out;
  } catch (e) {
    return errMsg(e);
  }
}

async function getThermal(): Promise<string> {
  try {
    const out = await shell("pmset", ["-g", "therm"]);
    // Look for "System Thermal Level" or "CPU_Scheduler_Limit"
    const cpuLimit = out.match(/CPU_Scheduler_Limit\s*=\s*(\d+)/)?.[1];
    const cpuAvail = out.match(/CPU_Available_CPUs\s*=\s*(\d+)/)?.[1];
    const thermalLevel = out.match(/System Thermal Level\s*=\s*(\d+)/)?.[1];
    const parts: string[] = [];
    if (thermalLevel !== undefined) parts.push(`level ${thermalLevel}`);
    if (cpuLimit !== undefined) parts.push(`CPU scheduler limit ${cpuLimit}%`);
    if (cpuAvail !== undefined) parts.push(`available CPUs ${cpuAvail}`);
    return parts.length > 0 ? parts.join(", ") : "nominal";
  } catch (e) {
    return errMsg(e);
  }
}

async function getProcessCount(): Promise<number> {
  try {
    const out = await shell("ps", ["-A", "-o", "pid="]);
    return out.split("\n").filter(Boolean).length;
  } catch {
    return -1;
  }
}

async function getDisk(): Promise<string> {
  try {
    const out = await shell("df", ["-k", "-P", "/"]);
    const parts = out.split("\n")[1]?.split(/\s+/);
    if (!parts || parts.length < 4) return "조회 실패";
    const diskTotal = Number(parts[1]) * 1024;
    const diskUsed = Number(parts[2]) * 1024;
    const diskAvail = Number(parts[3]) * 1024;
    const diskPct = ((diskUsed / diskTotal) * 100).toFixed(1);
    return `${fmtBytes(diskUsed)} / ${fmtBytes(diskTotal)} (${diskPct}%)  여유: ${fmtBytes(diskAvail)}`;
  } catch (e) {
    return errMsg(e);
  }
}

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
    const [memPressure, swap, thermal, disk, procCount] = await Promise.all([
      getMemoryPressure(),
      getSwapUsage(),
      getThermal(),
      getDisk(),
      getProcessCount(),
    ]);

    const total = totalmem();
    const free = freemem();
    const used = total - free;
    const memPct = ((used / total) * 100).toFixed(1);
    const [l1, l5, l15] = loadavg();
    const numCpus = cpus().length;

    return mcpOk(
      [
        "시스템 상태",
        "",
        `CPU 부하:      ${l1.toFixed(2)} / ${l5.toFixed(2)} / ${l15.toFixed(2)}  (1/5/15분, 코어 ${numCpus}개)`,
        `메모리:        ${fmtBytes(used)} / ${fmtBytes(total)} (${memPct}%)  여유: ${fmtBytes(free)}`,
        `메모리 압력:   ${memPressure}`,
        `스왑:          ${swap}`,
        `디스크(/):     ${disk}`,
        `열 상태:       ${thermal}`,
        `프로세스 수:   ${procCount > 0 ? `${procCount}개` : "조회 실패"}`,
      ].join("\n"),
    );
  },
);

await connectStdio(server);
