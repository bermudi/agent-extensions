/**
 * Local SQLite usage store for the xonsh tool.
 *
 * Mirrors pi-delegate's telemetry backend at a smaller scale: every completed
 * `xonsh` invocation is written once to a local SQLite database so usage and
 * health trends (duration, output growth, dependency counts, timeouts) can be
 * inspected without parsing session logs.
 *
 * The database defaults to `~/.pi/agent/xonsh-usage.db`. Configuration is
 * environment-based because this is an experiment, not a published package:
 *
 *   XONSH_USAGE_ENABLED=false   disable recording entirely
 *   XONSH_USAGE_DB=/path/to.db  override the database path
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { DatabaseSync, StatementSync } from "node:sqlite";

export interface ExecutionRecord {
  id: string;
  ts: number;
  pi_version: string | undefined;
  xonsh_version: string | undefined;
  cwd: string;
  command_chars: number;
  deps: string;
  deps_count: number;
  timeout_ms: number | null;
  wall_ms: number;
  exit_code: number | null;
  timed_out: number;
  aborted: number;
  status: string;
  output_bytes: number;
  output_lines: number;
  truncated: number;
  kept_output_file: number;
}

export interface UsageRecorder {
  recordExecution(record: ExecutionRecord): void;
}

let DatabaseSyncCtor: typeof DatabaseSync | undefined;

try {
  const req = createRequire(import.meta.url);
  const sqlite = req("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
  DatabaseSyncCtor = sqlite.DatabaseSync;
} catch {
  DatabaseSyncCtor = undefined;
}

interface UsageBackend {
  recordExecution(record: ExecutionRecord): void;
  close(): void;
}

let backend: UsageBackend | undefined;
let backendGeneration: number | undefined;
let backendFailed = false;
let usageGeneration = 0;
let usageClosed = false;
let testingRecorder: UsageRecorder | undefined;

const USAGE_SCHEMA_VERSION = 1;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

type UsageColumn = readonly [name: string, definition: string];

const USAGE_COLUMNS: readonly UsageColumn[] = [
  ["id", "TEXT PRIMARY KEY"],
  ["ts", "INTEGER"],
  ["pi_version", "TEXT"],
  ["xonsh_version", "TEXT"],
  ["cwd", "TEXT"],
  ["command_chars", "INTEGER"],
  ["deps", "TEXT"],
  ["deps_count", "INTEGER"],
  ["timeout_ms", "INTEGER"],
  ["wall_ms", "INTEGER"],
  ["exit_code", "INTEGER"],
  ["timed_out", "INTEGER"],
  ["aborted", "INTEGER"],
  ["status", "TEXT"],
  ["output_bytes", "INTEGER"],
  ["output_lines", "INTEGER"],
  ["truncated", "INTEGER"],
  ["kept_output_file", "INTEGER"],
];

const CREATE_EXECUTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS executions(
    id TEXT PRIMARY KEY,
    ts INTEGER,
    pi_version TEXT,
    xonsh_version TEXT,
    cwd TEXT,
    command_chars INTEGER,
    deps TEXT,
    deps_count INTEGER,
    timeout_ms INTEGER,
    wall_ms INTEGER,
    exit_code INTEGER,
    timed_out INTEGER,
    aborted INTEGER,
    status TEXT,
    output_bytes INTEGER,
    output_lines INTEGER,
    truncated INTEGER,
    kept_output_file INTEGER
  );
`;

function defaultDbPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "xonsh-usage.db");
}

function usageEnabled(): boolean {
  const raw = process.env.XONSH_USAGE_ENABLED;
  if (raw === undefined) return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

function configuredDbPath(): string {
  const raw = process.env.XONSH_USAGE_DB?.trim();
  return raw ? raw : defaultDbPath();
}

function existingTableType(db: DatabaseSync): string | undefined {
  const row = db
    .prepare("SELECT type FROM sqlite_master WHERE name = ?")
    .get("executions") as { type?: unknown } | undefined;
  return typeof row?.type === "string" ? row.type : undefined;
}

function existingColumns(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("PRAGMA table_info(executions)")
    .all() as unknown as Array<{ name?: unknown }>;
  return new Set(
    rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
}

/**
 * Create or repair the executions table. The version marker is written last so
 * an interrupted migration leaves a version-0 database that can be retried.
 */
function initSchema(db: DatabaseSync): void {
  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;

    const row = db.prepare("PRAGMA user_version").get() as
      { user_version?: number } | undefined;
    const currentVersion = row?.user_version ?? 0;
    if (currentVersion > USAGE_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported xonsh usage schema version ${currentVersion}; expected at most ${USAGE_SCHEMA_VERSION}`,
      );
    }

    const type = existingTableType(db);
    if (type !== undefined && type !== "table") {
      throw new Error(`xonsh usage object executions is ${type}, not a table`);
    }
    db.exec(CREATE_EXECUTIONS_SQL);

    const columns = existingColumns(db);
    for (const [name, definition] of USAGE_COLUMNS) {
      if (columns.has(name)) continue;
      if (name === "id") {
        throw new Error(
          "xonsh usage table executions is missing its id column",
        );
      }
      db.exec(`ALTER TABLE executions ADD COLUMN ${name} ${definition}`);
    }

    db.exec(`PRAGMA user_version = ${USAGE_SCHEMA_VERSION}`);
    db.exec("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        console.error("[xonsh] usage schema rollback failed", rollbackError);
      }
    }
    throw error;
  }
}

class SqliteUsageBackend implements UsageBackend {
  private db: DatabaseSync;
  private insert: StatementSync;
  private readonly onFailure: (operation: string, error: unknown) => void;

  constructor(
    db: DatabaseSync,
    onFailure: (operation: string, error: unknown) => void,
  ) {
    this.db = db;
    this.onFailure = onFailure;
    this.insert = db.prepare(
      `INSERT OR REPLACE INTO executions(
        id, ts, pi_version, xonsh_version, cwd, command_chars, deps,
        deps_count, timeout_ms, wall_ms, exit_code, timed_out, aborted, status,
        output_bytes, output_lines, truncated, kept_output_file
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  recordExecution(record: ExecutionRecord): void {
    try {
      this.insert.run(
        record.id,
        record.ts,
        record.pi_version ?? null,
        record.xonsh_version ?? null,
        record.cwd,
        record.command_chars,
        record.deps,
        record.deps_count,
        record.timeout_ms,
        record.wall_ms,
        record.exit_code,
        record.timed_out,
        record.aborted,
        record.status,
        record.output_bytes,
        record.output_lines,
        record.truncated,
        record.kept_output_file,
      );
    } catch (error) {
      this.onFailure("recordExecution", error);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (error) {
      console.error("[xonsh] usage database close failed", error);
    }
  }
}

class RecorderBackend implements UsageBackend {
  private readonly recorder: UsageRecorder;
  private readonly onFailure: (operation: string, error: unknown) => void;

  constructor(
    recorder: UsageRecorder,
    onFailure: (operation: string, error: unknown) => void,
  ) {
    this.recorder = recorder;
    this.onFailure = onFailure;
  }

  recordExecution(record: ExecutionRecord): void {
    try {
      this.recorder.recordExecution(record);
    } catch (error) {
      this.onFailure("recordExecution", error);
    }
  }

  close(): void {}
}

function disableBackend(operation: string, error: unknown): void {
  if (backendFailed) return;
  backendFailed = true;
  const failedBackend = backend;
  backend = undefined;
  try {
    failedBackend?.close();
  } catch (closeError) {
    console.error("[xonsh] usage backend close failed", closeError);
  }
  console.error(
    `[xonsh] usage ${operation} failed; disabling usage recording`,
    error,
  );
}

function openBackend(): UsageBackend | undefined {
  if (!usageEnabled() || backendFailed || usageClosed) return undefined;
  if (testingRecorder)
    return new RecorderBackend(testingRecorder, disableBackend);

  if (!DatabaseSyncCtor) {
    backendFailed = true;
    return undefined;
  }

  const dbPath = configuredDbPath();
  let db: DatabaseSync | undefined;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSyncCtor(dbPath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    db.exec("PRAGMA journal_mode = WAL;");
    initSchema(db);
    return new SqliteUsageBackend(db, disableBackend);
  } catch (error) {
    try {
      db?.close();
    } catch (closeError) {
      console.error("[xonsh] usage database close failed", closeError);
    }
    backendFailed = true;
    console.error("[xonsh] usage database failed to open", error);
    return undefined;
  }
}

function getBackend(generation?: number): UsageBackend | undefined {
  if (usageClosed) return undefined;
  if (generation !== undefined && generation !== usageGeneration) {
    return undefined;
  }
  if (backend) {
    if (backendGeneration !== usageGeneration) {
      const stale = backend;
      backend = undefined;
      backendGeneration = undefined;
      stale.close();
    } else if (generation !== undefined && backendGeneration !== generation) {
      return undefined;
    } else {
      return backend;
    }
  }
  backend = openBackend();
  if (backend) backendGeneration = usageGeneration;
  return backend;
}

export interface ExecutionInput {
  xonshVersion?: string;
  cwd: string;
  commandChars: number;
  deps: readonly string[];
  timeoutMs: number | null;
  wallMs: number;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  status: "success" | "failed" | "cancelled" | "timed_out";
  outputBytes: number;
  outputLines: number;
  truncated: boolean;
  keptOutputFile: boolean;
}

/** Current runtime identity for lifecycle owners such as session_shutdown. */
export function getUsageGeneration(): number {
  return usageGeneration;
}

/**
 * Record one completed xonsh invocation. `generation` is captured by the
 * extension when a run starts so a stale runtime cannot write after reload.
 */
export function recordExecution(
  input: ExecutionInput,
  generation?: number,
): void {
  const backend = getBackend(generation);
  if (!backend) return;

  const record: ExecutionRecord = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    pi_version: getPiVersion(),
    xonsh_version: input.xonshVersion,
    cwd: input.cwd,
    command_chars: input.commandChars,
    deps: JSON.stringify(input.deps),
    deps_count: input.deps.length,
    timeout_ms: input.timeoutMs,
    wall_ms: input.wallMs,
    exit_code: input.exitCode,
    timed_out: input.timedOut ? 1 : 0,
    aborted: input.aborted ? 1 : 0,
    status: input.status,
    output_bytes: input.outputBytes,
    output_lines: input.outputLines,
    truncated: input.truncated ? 1 : 0,
    kept_output_file: input.keptOutputFile ? 1 : 0,
  };
  backend.recordExecution(record);
}

/** Prevent stale work from reopening the store after this runtime shuts down. */
export function closeUsage(expectedGeneration?: number): void {
  if (
    expectedGeneration !== undefined &&
    expectedGeneration !== usageGeneration
  ) {
    return;
  }
  usageClosed = true;
  const current = backend;
  backend = undefined;
  backendGeneration = undefined;
  current?.close();
}

/** Mark the start of a fresh extension runtime after a reload. */
export function prepareUsageForSession(): void {
  const stale = backend;
  backend = undefined;
  backendGeneration = undefined;
  stale?.close();

  // A temporary open/write failure must not disable recording for the next
  // extension runtime. Reloads reuse this module instance, so reset the failed
  // flag here rather than only on process restart.
  backendFailed = false;
  usageGeneration++;
  usageClosed = false;
}

let piVersion: string | undefined;

function getPiVersion(): string | undefined {
  if (piVersion === undefined) {
    const candidate = (piCodingAgent as Record<string, unknown>).VERSION;
    piVersion =
      typeof candidate === "string" && candidate.length > 0
        ? candidate
        : undefined;
  }
  return piVersion;
}

export function _setUsageForTesting(recorder: UsageRecorder | undefined): void {
  if (backend) {
    backend.close();
    backend = undefined;
    backendGeneration = undefined;
  }
  testingRecorder = recorder;
  backendFailed = false;
  usageGeneration++;
  usageClosed = false;
}

export function _resetUsageForTesting(): void {
  testingRecorder = undefined;
  if (backend) {
    backend.close();
    backend = undefined;
    backendGeneration = undefined;
  }
  backendFailed = false;
  usageGeneration++;
  usageClosed = false;
}
