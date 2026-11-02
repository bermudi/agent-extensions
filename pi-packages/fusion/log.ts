// Operational log: JSONL under <agent dir>/fusion/. Never stdout (pi owns the
// terminal). Logs events and sizes only — never brief or report bodies.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Logger } from "./types.ts";

function fusionDir(): string {
  const dir = process.env.FUSION_LOG_DIR ?? join(getAgentDir(), "fusion");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function createLogger(): Logger {
  const write = (
    level: string,
    event: string,
    data?: Record<string, unknown>,
  ) => {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        level,
        event,
        ...data,
      });
      appendFileSync(join(fusionDir(), "fusion.log"), `${line}\n`, {
        mode: 0o600,
      });
    } catch {
      // Logging must never break a handoff.
    }
  };
  return {
    info: (event, data) => write("info", event, data),
    warn: (event, data) => write("warn", event, data),
    error: (event, data) => write("error", event, data),
  };
}

/** Full text of an oversized report, so the lead can read the rest. */
export function saveReport(handoffId: number, report: string): string {
  const dir = join(fusionDir(), "reports");
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `${process.pid}-${Date.now()}-handoff-${handoffId}.md`,
  );
  writeFileSync(path, report, { mode: 0o600 });
  return path;
}
