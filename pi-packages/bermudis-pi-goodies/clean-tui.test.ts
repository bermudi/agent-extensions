import { describe, expect, test } from "bun:test";
import { Box, Container } from "@earendil-works/pi-tui";
import cleanTui from "./clean-tui";

type Handler = (...args: any[]) => void;
type ToolDef = {
  name: string;
  renderCall: (args: any, theme: any, ctx: any) => any;
  renderResult: (result: any, opts: any, theme: any, ctx: any) => any;
};

const theme = {
  fg: (_name: string, s: string) => s,
  bg: (_name: string, s: string) => s,
  bold: (s: string) => s,
};

function loadExtension() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDef>();
  const pi = {
    on: (event: string, fn: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    registerTool: (def: ToolDef) => tools.set(def.name, def),
  };
  cleanTui(pi as any);
  const emit = (event: string, ...args: any[]) => {
    for (const fn of handlers.get(event) ?? []) fn(...args);
  };
  return { emit, tools };
}

function textOf(component: any): string {
  // Box children are Text components holding a raw `text` string
  return component.children?.map((c: any) => c.text ?? "").join("\n") ?? "";
}

describe("clean-tui resume/replay", () => {
  test("replayed history renders solo and stays fast (regression: /resume freeze)", () => {
    const { emit, tools } = loadExtension();
    emit("session_start", { reason: "resume" });

    const read = tools.get("read")!;
    const start = Date.now();
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const ctx = {
        toolCallId: `t${i}`,
        invalidate: () => {},
        expanded: false,
      };
      const call = read.renderCall({ path: `/tmp/f${i}.ts` }, theme, ctx);
      // No turn_start fires during replay, so every row must be solo —
      // never a hidden follower of a cross-history mega-burst.
      expect(call instanceof Container).toBe(false);
      read.renderResult(
        { content: [{ type: "text", text: "ok" }] },
        { expanded: false },
        theme,
        { ...ctx, isError: false },
      );
    }
    const elapsed = Date.now() - start;
    // Cubic revalidation used to make this take minutes; solo replay is linear.
    expect(elapsed).toBeLessThan(5000);
  });

  test("live bursts still group after turn_start", () => {
    const { emit, tools } = loadExtension();
    emit("session_start", { reason: "startup" });
    emit("turn_start", {});

    const read = tools.get("read")!;
    const mkCtx = (id: string) => ({
      toolCallId: id,
      invalidate: () => {},
      expanded: false,
    });
    const r0 = read.renderCall({ path: "/tmp/a.ts" }, theme, mkCtx("a"));
    const r1 = read.renderCall({ path: "/tmp/b.ts" }, theme, mkCtx("b"));
    // Second call joins the burst as a hidden follower.
    expect(r1 instanceof Container).toBe(true);
    read.renderResult(
      { content: [{ type: "text", text: "ok" }] },
      { expanded: false },
      theme,
      { ...mkCtx("a"), isError: false },
    );
    read.renderResult(
      { content: [{ type: "text", text: "ok" }] },
      { expanded: false },
      theme,
      { ...mkCtx("b"), isError: false },
    );
    // Results trigger invalidation → leader rerenders as a ×2 group.
    const r0b = read.renderCall({ path: "/tmp/a.ts" }, theme, mkCtx("a"));
    expect(r0b instanceof Box).toBe(true);
    expect(textOf(r0b)).toContain("×2");

    // A different tool breaks the burst.
    const bash = tools.get("bash")!;
    const b0 = bash.renderCall({ command: "echo hi" }, theme, mkCtx("c"));
    expect(b0 instanceof Box).toBe(true);
    expect(textOf(b0)).not.toContain("×2");

    // A new turn starts a fresh burst.
    emit("turn_start", {});
    const r2 = read.renderCall({ path: "/tmp/c.ts" }, theme, mkCtx("d"));
    expect(textOf(r2)).not.toContain("×2");
  });
});
