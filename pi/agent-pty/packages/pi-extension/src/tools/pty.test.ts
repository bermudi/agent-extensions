import { describe, it, expect } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setupPtyTools } from "./pty.js";
import {
  deriveStatus,
  deriveStatusFromResult,
  formatRuntime,
  statusIcon,
  statusColor,
  statusLabel,
  truncate,
} from "../utils/format.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function mockTheme() {
  return {
    fg: (_key: string, text: string) => text,
    bold: (text: string) => `**${text}**`,
  } as any;
}

function mockRenderCtx() {
  return {
    state: {},
    lastComponent: null,
    invalidate: () => {},
  } as any;
}

function createMockPi(): ExtensionAPI {
  const tools: any[] = [];
  return {
    registerTool: (def: any) => { tools.push(def); },
    getRegisteredTools: () => tools,
  } as any;
}

function getPtyTool(pi: ExtensionAPI) {
  const tools = (pi as any).getRegisteredTools() as any[];
  return tools.find((t) => t.name === "pty");
}

function getText(component: any): string {
  if (component && typeof component.getText === "function") {
    return component.getText();
  }
  if (component && typeof component.text === "string") {
    return component.text;
  }
  return String(component);
}

// ── Extension integration ────────────────────────────────────────────────

describe("pty extension", () => {
  it("registers the pty tool", () => {
    const pi = createMockPi();
    setupPtyTools(pi);

    const tool = getPtyTool(pi);
    expect(tool).toBeDefined();
    expect(tool.name).toBe("pty");
    expect(tool.label).toBe("PTY");
    expect(tool.description).toContain("pseudo-terminal");
  });
});

// ── renderCall ───────────────────────────────────────────────────────────

describe("renderCall", () => {
  const pi = createMockPi();
  setupPtyTools(pi);
  const tool = getPtyTool(pi)!;
  const theme = mockTheme();
  const ctx = mockRenderCtx();

  it("shows spawn with name and command", () => {
    const text = getText(tool.renderCall({ action: "spawn", name: "demo", command: "bash" }, theme, ctx));
    expect(text).toContain("pty");
    expect(text).toContain("spawn");
    expect(text).toContain("demo");
    expect(text).toContain("bash");
  });

  it("shows type with truncated text", () => {
    const text = getText(tool.renderCall({ action: "type", name: "demo", text: "hello world" }, theme, ctx));
    expect(text).toContain("type");
    expect(text).toContain("demo");
    expect(text).toContain("hello world");
  });

  it("shows key action", () => {
    const text = getText(tool.renderCall({ action: "key", name: "demo", key: "enter" }, theme, ctx));
    expect(text).toContain("key");
    expect(text).toContain("enter");
  });

  it("shows snapshot action", () => {
    const text = getText(tool.renderCall({ action: "snapshot", name: "demo" }, theme, ctx));
    expect(text).toContain("snapshot");
    expect(text).toContain("demo");
  });

  it("shows list_sessions without name", () => {
    const text = getText(tool.renderCall({ action: "list_sessions" }, theme, ctx));
    expect(text).toContain("list_sessions");
  });
});

// ── renderResult ─────────────────────────────────────────────────────────

describe("renderResult", () => {
  const pi = createMockPi();
  setupPtyTools(pi);
  const tool = getPtyTool(pi)!;
  const theme = mockTheme();
  const ctx = mockRenderCtx();

  function makeResult(action: string, success: boolean, result: Record<string, unknown>) {
    const message = success ? "OK" : (String(result.error ?? "unknown error"));
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: { action, success, message, result },
    };
  }

  it("shows spawn result with name and pid", () => {
    const result = makeResult("spawn", true, { ok: true, name: "demo", pid: 12345 });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("Started PTY session");
    expect(text).toContain("demo");
    expect(text).toContain("12345");
  });

  it("shows list result with sessions", () => {
    const result = makeResult("list_sessions", true, {
      ok: true,
      sessions: [
        { name: "demo", command: "bash", cwd: "/tmp", pid: 123, createdAt: new Date().toISOString() },
        { name: "test", command: "npm test", cwd: "/proj", pid: 456, createdAt: new Date().toISOString(), killedAt: new Date().toISOString() },
      ],
    });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("2 session(s)");
    expect(text).toContain("demo");
    expect(text).toContain("test");
    expect(text).toContain("bash");
    expect(text).toContain("npm test");
  });

  it("shows empty list", () => {
    const result = makeResult("list_sessions", true, { ok: true, sessions: [] });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("No PTY sessions");
  });

  it("shows snapshot with metadata", () => {
    const result = makeResult("snapshot", true, {
      ok: true,
      snapshotId: 5,
      text: "hello\nworld",
      size: { cols: 80, rows: 24 },
      cursor: { row: 1, col: 5 },
      contentHash: "abc123",
    });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("Snapshot #5");
    expect(text).toContain("80×24");
    expect(text).toContain("hello");
    expect(text).toContain("world");
  });

  it("shows scroll result", () => {
    const result = makeResult("scroll", true, { ok: true, lines: ["line1", "line2"], text: "line1\nline2" });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("Scrollback");
    expect(text).toContain("2 lines");
    expect(text).toContain("line1");
  });

  it("shows wait_for match", () => {
    const result = makeResult("wait_for", true, { ok: true, matched: true, elapsed: 150 });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("matched");
    expect(text).toContain("150ms");
  });

  it("shows wait_for timeout", () => {
    const result = makeResult("wait_for", true, { ok: true, matched: false, timedOut: true, elapsed: 30000 });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("Timed out");
  });

  it("shows await_change settled", () => {
    const result = makeResult("await_change", true, { ok: true, changed: true, settled: true, elapsed: 500 });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("changed and settled");
  });

  it("shows wait_for_exit with exit code", () => {
    const result = makeResult("wait_for_exit", true, { ok: true, exited: true, exitCode: 0, elapsed: 1000 });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("exited(0)");
    expect(text).toContain("1000ms");
  });

  it("shows wait_for_exit with signal", () => {
    const result = makeResult("wait_for_exit", true, { ok: true, exited: true, exitCode: null, signal: 9, elapsed: 500 });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("killed");
  });

  it("shows wait_for_exit timeout", () => {
    const result = makeResult("wait_for_exit", true, { ok: true, exited: false, timedOut: true, elapsed: 30000 });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("timed out");
  });

  it("shows type confirmation", () => {
    const result = makeResult("type", true, { ok: true });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("Sent");
  });

  it("shows key confirmation with sequence", () => {
    const result = makeResult("key", true, { ok: true, sent: "\r" });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("Sent");
    expect(text).toContain("\r");
  });

  it("shows kill result", () => {
    const result = makeResult("kill", true, { ok: true, killedAt: "2026-01-01T00:00:00Z" });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("killed");
  });

  it("shows remove result", () => {
    const result = makeResult("remove", true, { ok: true });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("removed");
  });

  it("shows error on failure", () => {
    const result = makeResult("spawn", false, { ok: false, error: "session already exists" });
    const text = getText(tool.renderResult(result, { isPartial: false, expanded: false }, theme, ctx));
    expect(text).toContain("session already exists");
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────────

describe("formatRuntime", () => {
  it("formats seconds", () => {
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 42000).toISOString();
    expect(formatRuntime(past)).toBe("42s");
  });

  it("formats minutes and seconds", () => {
    const past = new Date(Date.now() - 125000).toISOString();
    expect(formatRuntime(past)).toBe("2m 5s");
  });

  it("formats hours", () => {
    const past = new Date(Date.now() - 3660000).toISOString();
    expect(formatRuntime(past)).toBe("1h 1m");
  });

  it("uses killedAt when provided", () => {
    const start = new Date("2026-01-01T00:00:00Z").toISOString();
    const end = new Date("2026-01-01T00:00:05Z").toISOString();
    expect(formatRuntime(start, end)).toBe("5s");
  });
});

describe("status helpers", () => {
  it("running status", () => {
    expect(statusIcon({ status: "running" })).toBe("●");
    expect(statusColor({ status: "running" })).toBe("success");
    expect(statusLabel({ status: "running" })).toBe("running");
  });

  it("exited(0) status", () => {
    expect(statusIcon({ status: "exited", exitCode: 0 })).toBe("✓");
    expect(statusColor({ status: "exited", exitCode: 0 })).toBe("dim");
    expect(statusLabel({ status: "exited", exitCode: 0 })).toBe("exited(0)");
  });

  it("exited(1) status", () => {
    expect(statusIcon({ status: "exited", exitCode: 1 })).toBe("✗");
    expect(statusColor({ status: "exited", exitCode: 1 })).toBe("error");
    expect(statusLabel({ status: "exited", exitCode: 1 })).toBe("exited(1)");
  });

  it("killed status", () => {
    expect(statusIcon({ status: "killed" })).toBe("✗");
    expect(statusColor({ status: "killed" })).toBe("warning");
    expect(statusLabel({ status: "killed" })).toBe("killed");
  });

  it("killed with signal", () => {
    expect(statusLabel({ status: "killed", signal: 9 })).toBe("killed(9)");
  });
});

describe("deriveStatus", () => {
  it("returns running when no killedAt", () => {
    const s = { name: "a", command: "b", cwd: "/", pid: 1, createdAt: new Date().toISOString() };
    expect(deriveStatus(s)).toEqual({ status: "running" });
  });

  it("returns killed when killedAt present", () => {
    const s = { name: "a", command: "b", cwd: "/", pid: 1, createdAt: new Date().toISOString(), killedAt: new Date().toISOString() };
    expect(deriveStatus(s)).toEqual({ status: "killed" });
  });
});

describe("deriveStatusFromResult", () => {
  it("running from empty result", () => {
    expect(deriveStatusFromResult({})).toEqual({ status: "running" });
  });

  it("exited(0)", () => {
    expect(deriveStatusFromResult({ exited: true, exitCode: 0 })).toEqual({ status: "exited", exitCode: 0 });
  });

  it("exited with signal", () => {
    expect(deriveStatusFromResult({ exited: true, exitCode: null, signal: 9 })).toEqual({ status: "killed", signal: 9 });
  });

  it("killed from killedAt", () => {
    expect(deriveStatusFromResult({ killedAt: "2026-01-01" })).toEqual({ status: "killed" });
  });
});

describe("truncate", () => {
  it("keeps short strings", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates with ellipsis", () => {
    expect(truncate("hello world", 8)).toBe("hello...");
  });

  it("respects maxLen <= 3", () => {
    expect(truncate("hello", 2)).toBe("he");
  });
});
