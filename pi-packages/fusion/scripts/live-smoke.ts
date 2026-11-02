// Live smoke for the connectors (real harness, real model turns). Not part of `bun test`.
// Usage: bun run scripts/live-smoke.ts <piz|devin> <model> <scratch-cwd>
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { connectDevin } from "../devin.ts";
import { connectPiz } from "../piz.ts";
import type { HarnessId, Logger } from "../types.ts";

const USAGE =
  "Usage: bun run scripts/live-smoke.ts <piz|devin> <model> <scratch-cwd>";

const argsSchema = z.tuple([
  z.enum(["piz", "devin"]),
  z.string().refine((v) => v.trim().length > 0),
  z.string().refine((v) => v.trim().length > 0),
]);

export const parseSmokeArgs = async (
  args: string[],
): Promise<{ harness: HarnessId; model: string; cwd: string }> => {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) throw new Error(USAGE);
  const [harness, model, cwd] = parsed.data;
  const absolute = resolve(cwd);
  const info = await stat(absolute).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error(`scratch cwd is not a directory: ${cwd}\n${USAGE}`);
  }
  return { harness, model, cwd: absolute };
};

const main = async () => {
  const { harness, model, cwd } = await parseSmokeArgs(process.argv.slice(2));
  const log: Logger = {
    info: (e, d) => console.error("info", e, JSON.stringify(d ?? {})),
    warn: (e, d) => console.error("WARN", e, JSON.stringify(d ?? {})),
    error: (e, d) => console.error("ERROR", e, JSON.stringify(d ?? {})),
  };
  const connect = harness === "piz" ? connectPiz : connectDevin;
  const t0 = Date.now();
  const ts = () => ((Date.now() - t0) / 1000).toFixed(1);
  const sk = await connect({ cwd, model, log });
  console.log(ts(), "connected", sk.harness, sk.model, sk.sessionId);
  const cb = {
    onActivity: (a: { kind: string; text: string }) =>
      console.log(
        ts(),
        "  activity",
        a.kind,
        a.text.split("\n")[0]!.slice(0, 100),
      ),
  };
  const ctl = new AbortController();
  const p1 = sk.prompt(
    "Run the shell command `sleep 10 && echo slept`, wait for it, then create b.txt containing exactly: first. Report in one line.",
    cb,
    ctl.signal,
  );
  await Bun.sleep(6000);
  console.log(
    ts(),
    "inject ->",
    await sk.inject(
      "<lead_update>\nAlso create c.txt containing exactly: second.\n</lead_update>",
    ),
  );
  const r1 = await p1;
  console.log(ts(), "R1", JSON.stringify(r1).slice(0, 400));
  const r2 = await sk.prompt(
    "What files did you create so far in this session? One line.",
    cb,
    ctl.signal,
  );
  console.log(ts(), "R2 (memory)", JSON.stringify(r2).slice(0, 300));
  const sid = sk.sessionId;
  await sk.dispose();
  console.log(ts(), "disposed; reattaching", sid);
  const sk2 = await connect({ cwd, model, log, resumeSessionId: sid });
  console.log(
    ts(),
    "reattached",
    sk2.sessionId,
    sk2.sessionId === sid ? "SAME" : "DIFFERENT",
  );
  const r3 = await sk2.prompt(
    "Without running any tools: which two files did you create earlier? One line.",
    cb,
    ctl.signal,
  );
  console.log(ts(), "R3 (after reattach)", JSON.stringify(r3).slice(0, 300));
  await sk2.dispose();
  console.log(
    ts(),
    "files:",
    (await Array.fromAsync(new Bun.Glob("*.txt").scan(cwd))).sort().join(","),
  );
  process.exit(0);
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
