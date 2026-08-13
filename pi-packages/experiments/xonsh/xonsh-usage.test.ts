import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import {
  _resetUsageForTesting,
  _setUsageForTesting,
  closeUsage,
  getUsageGeneration,
  prepareUsageForSession,
  recordExecution,
  type ExecutionRecord,
  type UsageRecorder,
} from "./xonsh-usage.ts";

function makeRecorder(): {
  records: ExecutionRecord[];
  recorder: UsageRecorder;
} {
  const records: ExecutionRecord[] = [];
  return {
    records,
    recorder: {
      recordExecution: (record) => records.push(record),
    },
  };
}

const usageModule = pathToFileURL(
  path.join(import.meta.dir, "xonsh-usage.ts"),
).href;

function runNodeScript(
  source: string,
  dbPath: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.XONSH_NODE_BINARY ?? "node",
      ["--experimental-strip-types", "--input-type=module", "-e", source],
      {
        env: {
          ...process.env,
          XONSH_USAGE_ENABLED: "true",
          XONSH_USAGE_DB: dbPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Node usage worker exited with ${code}: ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function usageWorkerSource(): string {
  return `
    import { _resetUsageForTesting, recordExecution } from ${JSON.stringify(usageModule)};
    _resetUsageForTesting();
    recordExecution({
      xonshVersion: "0.24.1",
      cwd: "/tmp",
      commandChars: 5,
      deps: ["pandas"],
      timeoutMs: 1000,
      wallMs: 7,
      exitCode: 0,
      timedOut: false,
      aborted: false,
      status: "success",
      outputBytes: 12,
      outputLines: 1,
      truncated: false,
      keptOutputFile: false,
    });
  `;
}

async function readNodeDatabase(dbPath: string): Promise<{
  executions: number;
  userVersion: number;
  journalMode: string;
  piVersion: string | null;
  xonshVersion: string | null;
}> {
  const result = await runNodeScript(
    `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.env.XONSH_USAGE_DB);
      const one = (sql) => db.prepare(sql).get();
      console.log(JSON.stringify({
        executions: one("SELECT count(*) AS n FROM executions").n,
        userVersion: one("PRAGMA user_version").user_version,
        journalMode: one("PRAGMA journal_mode").journal_mode,
        piVersion: one("SELECT pi_version FROM executions LIMIT 1").pi_version,
        xonshVersion: one("SELECT xonsh_version FROM executions LIMIT 1").xonsh_version,
      }));
      db.close();
    `,
    dbPath,
  );
  return JSON.parse(result.stdout.trim()) as {
    executions: number;
    userVersion: number;
    journalMode: string;
    piVersion: string | null;
    xonshVersion: string | null;
  };
}

describe("xonsh usage", () => {
  beforeEach(() => {
    _resetUsageForTesting();
  });
  afterEach(() => {
    _resetUsageForTesting();
    delete process.env.XONSH_USAGE_ENABLED;
    delete process.env.XONSH_USAGE_DB;
  });

  test("records an execution with normalized fields", () => {
    const { records, recorder } = makeRecorder();
    _setUsageForTesting(recorder);

    recordExecution({
      xonshVersion: "0.24.1",
      cwd: "/tmp",
      commandChars: 9,
      deps: ["pandas", "openpyxl"],
      timeoutMs: 5000,
      wallMs: 42,
      exitCode: 1,
      timedOut: false,
      aborted: true,
      status: "cancelled",
      outputBytes: 100,
      outputLines: 3,
      truncated: true,
      keptOutputFile: true,
    });

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.id).toBeString();
    expect(record.ts).toBeGreaterThan(0);
    expect(record.pi_version).toBe(piCodingAgent.VERSION);
    expect(record.xonsh_version).toBe("0.24.1");
    expect(record.cwd).toBe("/tmp");
    expect(record.command_chars).toBe(9);
    expect(record.deps).toBe(JSON.stringify(["pandas", "openpyxl"]));
    expect(record.deps_count).toBe(2);
    expect(record.timeout_ms).toBe(5000);
    expect(record.wall_ms).toBe(42);
    expect(record.exit_code).toBe(1);
    expect(record.timed_out).toBe(0);
    expect(record.aborted).toBe(1);
    expect(record.status).toBe("cancelled");
    expect(record.output_bytes).toBe(100);
    expect(record.output_lines).toBe(3);
    expect(record.truncated).toBe(1);
    expect(record.kept_output_file).toBe(1);
  });

  test("disabled usage is a no-op", () => {
    const { records, recorder } = makeRecorder();
    _setUsageForTesting(recorder);
    process.env.XONSH_USAGE_ENABLED = "false";

    recordExecution({
      cwd: "/tmp",
      commandChars: 1,
      deps: [],
      timeoutMs: null,
      wallMs: 1,
      exitCode: 0,
      timedOut: false,
      aborted: false,
      status: "success",
      outputBytes: 0,
      outputLines: 0,
      truncated: false,
      keptOutputFile: false,
    });

    expect(records).toHaveLength(0);
  });

  test("a recorder failure disables recording after the first attempt", () => {
    let attempts = 0;
    _setUsageForTesting({
      recordExecution: () => {
        attempts += 1;
        throw new Error("test usage write failure");
      },
    });

    const input = () => ({
      cwd: "/tmp",
      commandChars: 1,
      deps: [] as string[],
      timeoutMs: null,
      wallMs: 1,
      exitCode: 0,
      timedOut: false,
      aborted: false,
      status: "success" as const,
      outputBytes: 0,
      outputLines: 0,
      truncated: false,
      keptOutputFile: false,
    });

    expect(() => recordExecution(input())).not.toThrow();
    expect(attempts).toBe(1);

    // A failed backend is disabled, so the second attempt must not reach the
    // recorder. This confirms the backend actually stopped after the first
    // failure rather than silently keeping the failed handle open.
    expect(() => recordExecution(input())).not.toThrow();
    expect(attempts).toBe(1);
  });

  test("prepareUsageForSession resets a failed backend", () => {
    let attempts = 0;
    _setUsageForTesting({
      recordExecution: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary usage failure");
      },
    });

    expect(() =>
      recordExecution({
        cwd: "/tmp",
        commandChars: 1,
        deps: [],
        timeoutMs: null,
        wallMs: 1,
        exitCode: 0,
        timedOut: false,
        aborted: false,
        status: "success",
        outputBytes: 0,
        outputLines: 0,
        truncated: false,
        keptOutputFile: false,
      }),
    ).not.toThrow();
    expect(attempts).toBe(1);

    prepareUsageForSession();
    expect(() =>
      recordExecution({
        cwd: "/tmp",
        commandChars: 1,
        deps: [],
        timeoutMs: null,
        wallMs: 1,
        exitCode: 0,
        timedOut: false,
        aborted: false,
        status: "success",
        outputBytes: 0,
        outputLines: 0,
        truncated: false,
        keptOutputFile: false,
      }),
    ).not.toThrow();
    expect(attempts).toBe(2);
  });

  test("stale generations cannot write after the runtime closes", () => {
    const old = makeRecorder();
    _setUsageForTesting(old.recorder);
    const generation = getUsageGeneration();

    closeUsage();
    recordExecution(
      {
        cwd: "/tmp",
        commandChars: 1,
        deps: [],
        timeoutMs: null,
        wallMs: 1,
        exitCode: 0,
        timedOut: false,
        aborted: false,
        status: "success",
        outputBytes: 0,
        outputLines: 0,
        truncated: false,
        keptOutputFile: false,
      },
      generation,
    );
    expect(old.records).toHaveLength(0);

    const current = makeRecorder();
    _setUsageForTesting(current.recorder);
    recordExecution({
      cwd: "/tmp",
      commandChars: 1,
      deps: [],
      timeoutMs: null,
      wallMs: 1,
      exitCode: 0,
      timedOut: false,
      aborted: false,
      status: "success",
      outputBytes: 0,
      outputLines: 0,
      truncated: false,
      keptOutputFile: false,
    });
    expect(current.records).toHaveLength(1);
  });

  test("prepareUsageForSession reopens a closed runtime", () => {
    const first = makeRecorder();
    _setUsageForTesting(first.recorder);
    closeUsage();
    expect(first.records).toHaveLength(0);

    prepareUsageForSession();
    recordExecution({
      cwd: "/tmp",
      commandChars: 1,
      deps: [],
      timeoutMs: null,
      wallMs: 1,
      exitCode: 0,
      timedOut: false,
      aborted: false,
      status: "success",
      outputBytes: 0,
      outputLines: 0,
      truncated: false,
      keptOutputFile: false,
    });
    expect(first.records).toHaveLength(1);
  });

  test(
    "Node SQLite backend records rows and opens with WAL",
    { timeout: 15_000 },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xonsh-usage-node-"));
      const dbPath = path.join(dir, "usage.db");
      try {
        await runNodeScript(usageWorkerSource(), dbPath);
        await expect(readNodeDatabase(dbPath)).resolves.toEqual({
          executions: 1,
          userVersion: 1,
          journalMode: "wal",
          piVersion: piCodingAgent.VERSION,
          xonshVersion: "0.24.1",
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test(
    "Node SQLite backend survives simultaneous first opens",
    { timeout: 15_000 },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xonsh-usage-race-"));
      const dbPath = path.join(dir, "usage.db");
      try {
        await Promise.all(
          Array.from({ length: 8 }, () =>
            runNodeScript(usageWorkerSource(), dbPath),
          ),
        );
        await expect(readNodeDatabase(dbPath)).resolves.toEqual({
          executions: 8,
          userVersion: 1,
          journalMode: "wal",
          piVersion: piCodingAgent.VERSION,
          xonshVersion: "0.24.1",
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
