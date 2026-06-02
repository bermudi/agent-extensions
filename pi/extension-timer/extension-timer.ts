import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import vm from "node:vm";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

// --- Extension Load Timer ---
//
// Hooks the full jiti pipeline to measure per-extension overhead:
//   1. fs.readFileSync(filename)      → record start time
//   2. jiti transforms TS → JS
//   3. vm.runInThisContext(code)      → wrap returned function
//   4. Module scope executes          → record end time
//   5. pi calls await factory(api)    → NOT directly observable
//
// We capture steps 1-4 precisely. Step 5 is estimated as the gap between
// the end of extension N's module eval and the start of extension N+1's file read.
//
// IMPORTANT: Named 0-extension-timer.ts so it loads first alphabetically.

const TIMER_KEY = "__pi_ext_timer_v3" as const;

function extractExtName(filename: string): string | null {
  const normalized = filename.replace(/\\/g, "/");
  const match = normalized.match(
    /(?:^|\/)(\.pi(?:\/agent)?\/extensions)\/(.+)$/
  );
  if (!match) return null;

  const relative = match[2];
  const direct = relative.match(/^([^/]+)\.(?:ts|js)$/);
  if (direct) return direct[1];
  const index = relative.match(/^([^/]+)\/index\.(?:ts|js)$/);
  if (index) return index[1];

  return null;
}

function isExtensionFile(filename: string): boolean {
  return extractExtName(filename) !== null;
}

if (!(globalThis as any)[TIMER_KEY]) {
  const myModuleStart = performance.now();

  const timings = new Map<string, { evalMs: number; totalMs: number }>();
  const loadStarts = new Map<string, number>();
  const evalEnds = new Map<string, number>();
  const fileOrder: string[] = [];
  let firstLoadStart = 0;

  // Hook fs.readFileSync — records when jiti starts reading each extension source
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function (
    filepath: fs.PathOrFileDescriptor,
    options?: any
  ): any {
    const filename = String(filepath);
    if (isExtensionFile(filename) && !loadStarts.has(filename)) {
      const now = performance.now();
      loadStarts.set(filename, now);
      fileOrder.push(filename);
      if (firstLoadStart === 0) firstLoadStart = now;
    }
    return (originalReadFileSync as any).call(fs, filepath, options);
  };

  // Hook vm.runInThisContext — wraps the compiled function to record eval end
  const originalRunInThisContext = vm.runInThisContext;
  vm.runInThisContext = function (
    code: string,
    options?: { filename?: string; lineOffset?: number; displayErrors?: boolean }
  ) {
    const result = originalRunInThisContext.call(vm, code, options);
    const filename = options?.filename || "";
    const extName = extractExtName(filename);

    if (!extName || typeof result !== "function") {
      return result;
    }

    return function (this: unknown, ...args: unknown[]) {
      const evalResult = result.apply(this, args);
      const now = performance.now();
      evalEnds.set(filename, now);

      const start = loadStarts.get(filename);
      if (start !== undefined) {
        timings.set(extName, { evalMs: now - start, totalMs: 0 });
      }

      return evalResult;
    };
  } as typeof vm.runInThisContext;

  (globalThis as any)[TIMER_KEY] = {
    timings,
    loadStarts,
    evalEnds,
    fileOrder,
    myModuleStart,
    firstLoadStart,
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const state = (globalThis as any)[TIMER_KEY];
    if (!state) return;

    const { timings, loadStarts, evalEnds, fileOrder, myModuleStart } = state;
    const sessionStart = performance.now();
    const totalStartup = sessionStart - myModuleStart;

    // Compute total time per extension = gap between its file read start
    // and the next extension's file read start (or session_start for last)
    for (let i = 0; i < fileOrder.length; i++) {
      const currentFile = fileOrder[i];
      const extName = extractExtName(currentFile);
      if (!extName || !timings.has(extName)) continue;

      const current = timings.get(extName)!;
      const loadStart = loadStarts.get(currentFile)!;

      let totalMs: number;
      if (i < fileOrder.length - 1) {
        const nextFile = fileOrder[i + 1];
        totalMs = loadStarts.get(nextFile)! - loadStart;
      } else {
        totalMs = sessionStart - loadStart;
      }

      // Gap includes next extension's file read (~1ms). Use evalMs as floor.
      totalMs = Math.max(totalMs, current.evalMs);
      timings.set(extName, { ...current, totalMs });
    }

    process.stderr.write(`[extension-timer] ${timings.size} entries, fileOrder=${fileOrder.length}, totalStartup=${totalStartup.toFixed(0)}ms\n`);
    for (const [n, v] of timings) process.stderr.write(`  ${n}: eval=${v.evalMs.toFixed(1)}ms, total=${v.totalMs.toFixed(1)}ms\n`);

    const entries = [...timings.entries()]
      .filter(([, v]) => v.totalMs > 0)
      .sort(([, a], [, b]) => a.totalMs - b.totalMs);

    if (entries.length === 0) return;

    const maxNameLen = Math.max(...entries.map(([name]) => name.length));
    const measuredEval = entries.reduce((sum, [, v]) => sum + v.evalMs, 0);
    const measuredTotal = entries.reduce((sum, [, v]) => sum + v.totalMs, 0);

    const lines = entries.map(([name, { evalMs, totalMs }]) => {
      const padded = name.padEnd(maxNameLen);
      const evalStr = evalMs.toFixed(0).padStart(3);
      const totalStr = totalMs.toFixed(0).padStart(4);
      return `  ${padded}  ${evalStr}ms  ${totalStr}ms`;
    });

    lines.push(
      `  ${"─".repeat(maxNameLen)}  ${"─".repeat(5)}  ${"─".repeat(6)}`,
      `  ${"compile".padEnd(maxNameLen)}  ${measuredEval.toFixed(0).padStart(3)}ms`,
      `  ${"measured".padEnd(maxNameLen)}  ${"".padStart(3)}  ${measuredTotal.toFixed(0).padStart(4)}ms`,
      `  ${"startup".padEnd(maxNameLen)}  ${"".padStart(3)}  ${totalStartup.toFixed(0).padStart(4)}ms`
    );

    ctx.ui.notify(`⏱  Extension load times\n${lines.join("\n")}`, "info");
  });
}
