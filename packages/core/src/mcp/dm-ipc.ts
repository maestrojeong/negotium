import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DM_CMD_DIR, DM_RESP_DIR } from "#platform/config";
import { appendJsonlEntry } from "#platform/jsonl";

export interface DmCommand {
  requestId: string;
  action: string;
  params: Record<string, unknown>;
  timestamp: string;
}

export function writeCommand(userId: string, cmd: DmCommand) {
  appendJsonlEntry(join(DM_CMD_DIR, `${userId}.jsonl`), cmd);
}

export function waitForResponse(
  userId: string,
  requestId: string,
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  const respFile = join(DM_RESP_DIR, `${userId}-${requestId}.json`);
  const start = Date.now();

  return new Promise((resolve, reject) => {
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const check = () => {
      if (existsSync(respFile)) {
        clearTimeout(timerId);
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(readFileSync(respFile, "utf-8"));
        } catch (e) {
          try {
            unlinkSync(respFile);
          } catch {}
          reject(e);
          return;
        }
        try {
          unlinkSync(respFile);
        } catch {}
        resolve(data);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearTimeout(timerId);
        reject(new Error("Timeout waiting for bot response"));
        return;
      }
      timerId = setTimeout(check, 500);
    };
    check();
  });
}

export function genRequestId(): string {
  return crypto.randomUUID();
}
