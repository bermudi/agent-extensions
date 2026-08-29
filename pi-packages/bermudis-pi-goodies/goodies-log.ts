// Shared capped failure log for the goodies package (~/.pi/agent/goodies.log).
//
// Why not console: pi's TUI owns the terminal and, in interactive mode,
// intercepts neither stdout nor stderr — anything an extension prints lands
// raw on the current frame and is wiped by the next repaint. That reads as
// an error message flashing too fast to read or screenshot, and it leaves no
// trace in any log. So anything that must outlive the moment is appended
// here; console output is reserved for headless modes, where there is no TUI
// to corrupt.

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GOODIES_LOG_DEFAULT_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "goodies.log",
);

const MAX_BYTES = 256 * 1024;
const KEEP_BYTES = 64 * 1024;

let logPath = GOODIES_LOG_DEFAULT_PATH;

/** Redirect the log (tests point this at scratch storage). */
export function setGoodiesLogPathForTesting(path?: string): void {
  logPath = path ?? GOODIES_LOG_DEFAULT_PATH;
}

/** Timestamped append; never throws — a broken log must not break callers. */
export function appendGoodiesLog(line: string): void {
  const stamped = `${new Date().toISOString()} [${process.pid}] ${line}`;
  try {
    if (statSync(logPath).size > MAX_BYTES) {
      // Size cap without timers or rotation daemons: keep the newest tail.
      writeFileSync(logPath, readFileSync(logPath).subarray(-KEEP_BYTES));
    }
  } catch {
    // Missing/unreadable file — the append below (re)creates it.
  }
  try {
    appendFileSync(logPath, `${stamped}\n`);
  } catch {
    // Unwritable destination — nothing else to do.
  }
}

/**
 * Report a failure durably: appended to the goodies log always, printed to
 * stderr only when headless (stdout is not a TTY). In TUI mode console
 * output is the unreadable flash described above; the file is the record.
 */
export function reportFailure(line: string): void {
  appendGoodiesLog(line);
  if (!process.stdout.isTTY) {
    console.error(line);
  }
}
