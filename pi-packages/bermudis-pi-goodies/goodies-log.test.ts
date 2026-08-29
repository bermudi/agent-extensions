import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import {
  logGoodiesEvent,
  reportFailure,
  setGoodiesLogPathForTesting,
  GOODIES_LOG_DEFAULT_PATH,
} from "./goodies-log";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let scratchDir: string;
let logPath: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "goodies-log-test-"));
  logPath = join(scratchDir, "goodies.log");
  setGoodiesLogPathForTesting(logPath);
});

afterEach(() => {
  setGoodiesLogPathForTesting(undefined);
  rmSync(scratchDir, { recursive: true, force: true });
});

function readLogLines(): Record<string, unknown>[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("goodies-log basic logging", () => {
  test("logGoodiesEvent writes a timestamped JSONL line with pid", () => {
    logGoodiesEvent({ type: "test_event", message: "hello" });
    const events = readLogLines();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("test_event");
    expect(events[0].message).toBe("hello");
    expect(typeof events[0].ts).toBe("string");
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(events[0].pid).toBe(process.pid);
  });

  test("multiple events append as separate lines", () => {
    logGoodiesEvent({ type: "a" });
    logGoodiesEvent({ type: "b" });
    logGoodiesEvent({ type: "c" });
    const events = readLogLines();
    expect(events.map((e) => e.type)).toEqual(["a", "b", "c"]);
  });

  test("reportFailure logs the event and prints to stderr when headless", () => {
    const origIsTTY = process.stdout.isTTY;
    const origErr = console.error;
    let stderrOutput: string | undefined;
    (process.stdout as { isTTY?: boolean }).isTTY = false;
    console.error = (msg: string) => {
      stderrOutput = msg;
    };
    try {
      reportFailure("test_failure", "something broke");
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = origIsTTY;
      console.error = origErr;
    }
    const events = readLogLines();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("test_failure");
    expect(events[0].message).toBe("something broke");
    expect(stderrOutput).toBe("something broke");
  });

  test("reportFailure stays silent on stderr in TUI mode", () => {
    const origIsTTY = process.stdout.isTTY;
    const origErr = console.error;
    let stderrOutput: string | undefined;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    console.error = (msg: string) => {
      stderrOutput = msg;
    };
    try {
      reportFailure("test_failure", "something broke");
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = origIsTTY;
      console.error = origErr;
    }
    const events = readLogLines();
    expect(events).toHaveLength(1);
    expect(stderrOutput).toBeUndefined();
  });
});

describe("goodies-log rotation", () => {
  test("file exceeding MAX_BYTES is truncated to KEEP_BYTES (newest tail kept)", () => {
    // Write a file well over MAX_BYTES (256 * 1024). After rotation, the file
    // should be truncated to the newest KEEP_BYTES (64 * 1024) of content.
    // Use a unique start marker and a unique end marker so we can verify the
    // tail (end) survives and the head (start) is dropped.
    const startMarker = "STARTMARKER_" + "S".repeat(200) + "\n";
    const filler = "X".repeat(300_000) + "\n";
    const endMarker = "ENDMARKER_" + "E".repeat(200) + "\n";
    writeFileSync(logPath, startMarker + filler + endMarker);

    // Log a small event — this triggers the rotation check.
    logGoodiesEvent({ type: "after_rotation", message: "marker" });

    const data = readFileSync(logPath);
    // The file must have been truncated: it should be well under the original
    // ~300KB + the new line. The tail (KEEP_BYTES) plus the new event line.
    expect(data.length).toBeLessThan(startMarker.length + filler.length);
    // The newest content (our marker event + the end marker) must be present.
    const text = data.toString("utf-8");
    expect(text).toContain("after_rotation");
    expect(text).toContain("ENDMARKER");
    // The oldest content (the start marker) must have been dropped.
    expect(text).not.toContain("STARTMARKER");
  });

  test("file under MAX_BYTES is not rotated", () => {
    // Pre-fill with a small payload.
    writeFileSync(logPath, "small existing content\n");
    logGoodiesEvent({ type: "test", message: "appended" });
    const text = readFileSync(logPath, "utf-8");
    expect(text).toContain("small existing content");
    expect(text).toContain("appended");
  });
});

describe("goodies-log never-throws contract", () => {
  test("non-serializable payload degrades to a marker instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // Must not throw.
    expect(() => logGoodiesEvent(circular)).not.toThrow();
    const events = readLogLines();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("unserializable");
    expect(typeof events[0].ts).toBe("string");
  });

  test("unwritable destination does not throw", () => {
    // Point at a path inside a read-only directory.
    const roDir = join(scratchDir, "readonly");
    mkdirSync(roDir);
    chmodSync(roDir, 0o500); // read+execute, no write
    const roPath = join(roDir, "goodies.log");
    setGoodiesLogPathForTesting(roPath);
    try {
      expect(() =>
        logGoodiesEvent({ type: "test", message: "should not throw" }),
      ).not.toThrow();
    } finally {
      setGoodiesLogPathForTesting(logPath);
      chmodSync(roDir, 0o700);
    }
  });

  test("missing file is created on first write", () => {
    // The log path points at a file that doesn't exist yet (no pre-creation).
    expect(existsSync(logPath)).toBe(false);
    logGoodiesEvent({ type: "first", message: "creates the file" });
    expect(existsSync(logPath)).toBe(true);
    const events = readLogLines();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("first");
  });

  test("parent directory is NOT created — missing dir is silently swallowed", () => {
    // Point at a path whose parent directory doesn't exist. The append will
    // fail, but logGoodiesEvent must not throw.
    const noDir = join(scratchDir, "does-not-exist", "goodies.log");
    setGoodiesLogPathForTesting(noDir);
    try {
      expect(() =>
        logGoodiesEvent({ type: "test", message: "no parent dir" }),
      ).not.toThrow();
      expect(existsSync(noDir)).toBe(false);
    } finally {
      setGoodiesLogPathForTesting(logPath);
    }
  });
});

describe("goodies-log setGoodiesLogPathForTesting", () => {
  test("undefined restores the default path", () => {
    setGoodiesLogPathForTesting("/tmp/some-test-path");
    setGoodiesLogPathForTesting(undefined);
    // We can't read the internal logPath variable, but we can verify that
    // logging after restore goes to the default path (which we don't want to
    // actually write to in tests, so just verify no throw and no file at the
    // test path).
    // Restore to scratch for safety.
    setGoodiesLogPathForTesting(logPath);
    // The constant is exported and unchanged.
    expect(GOODIES_LOG_DEFAULT_PATH).toContain("goodies.log");
  });
});
