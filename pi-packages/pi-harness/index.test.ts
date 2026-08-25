import { describe, expect, test } from "bun:test";
import {
  identityTheme,
  loadExtension,
  PiHarness,
  type ExtensionAPIStub,
  type ToolDefinition,
} from "./index";

describe("PiHarness basics", () => {
  test("captures event handlers and registered tools", () => {
    const h = new PiHarness();
    let fired = 0;
    const loader = (api: ExtensionAPIStub) => {
      api.on("turn_start", () => fired++);
      api.registerTool({
        name: "echo",
        renderCall: (args) => args,
      });
    };
    loadExtension(h, loader);
    expect(fired).toBe(0);
    h.emit("turn_start");
    expect(fired).toBe(1);
    expect(h.tool("echo").name).toBe("echo");
    expect(() => h.tool("nope")).toThrow(/no tool "nope"/);
  });
});

describe("ToolRow fidelity to ToolExecutionComponent", () => {
  test("renderResult fires on every repaint once a result exists", () => {
    const h = new PiHarness();
    let resultRenders = 0;
    let callRenders = 0;
    h.api.registerTool({
      name: "t",
      renderCall: () => {
        callRenders++;
        return null;
      },
      renderResult: () => {
        resultRenders++;
        return null;
      },
    });
    const row = h.row("t", "x1");
    row.setArgs({});
    expect(callRenders).toBe(1);
    expect(resultRenders).toBe(0); // no result yet
    row.setExpanded(true); // repaint without result
    expect(callRenders).toBe(2);
    expect(resultRenders).toBe(0);
    row.setResult({ content: ["out"] });
    expect(callRenders).toBe(3);
    expect(resultRenders).toBe(1);
    row.setExpanded(false); // repaint WITH result — the trap
    expect(callRenders).toBe(4);
    expect(resultRenders).toBe(2);
  });

  test("result wrapper object is fresh per render but content ref is stable", () => {
    const h = new PiHarness();
    const wrappers: unknown[] = [];
    const contents: unknown[] = [];
    h.api.registerTool({
      name: "t",
      renderCall: () => null,
      renderResult: (result) => {
        wrappers.push(result);
        contents.push((result as { content: unknown[] }).content);
        return null;
      },
    });
    const row = h.row("t", "x1");
    const shared = ["same"]; // pi reuses one content array across repaints
    row.setResult({ content: shared });
    row.setResult({ content: shared }); // repaint
    expect(wrappers[0]).not.toBe(wrappers[1]); // fresh wrapper
    expect(contents[0]).toBe(contents[1]); // stable content
  });

  test("ctx.invalidate synchronously re-renders the row", () => {
    const h = new PiHarness();
    let calls = 0;
    h.api.registerTool({
      name: "t",
      renderCall: (_args, _theme, ctx) => {
        calls++;
        if (calls === 1) ctx.invalidate();
        return null;
      },
    });
    const row = h.row("t", "x1");
    row.setArgs({});
    expect(calls).toBe(2); // invalidate landed before setArgs returned
    expect(row.updates).toBe(2);
  });

  test("renderer errors are swallowed into fallbacks, not thrown", () => {
    const h = new PiHarness();
    h.api.registerTool({
      name: "t",
      renderCall: () => {
        throw new Error("boom");
      },
      renderResult: () => {
        throw new Error("bang");
      },
    });
    const row = h.row("t", "x1");
    expect(() => {
      row.setArgs({});
      row.setResult({ content: ["x"] });
    }).not.toThrow();
    expect(row.fallbacks).toBe(3); // call slot on every pass + result slot once
    expect(row.errors).toHaveLength(3);
  });

  test("render churn aborts loudly instead of hanging", () => {
    const h = new PiHarness();
    // The exact pathology from goodies 0.9.0: every renderResult treats itself
    // as new state and invalidates its own row.
    h.api.registerTool({
      name: "t",
      renderCall: () => null,
      renderResult: (_result, _opts, _theme, ctx) => {
        ctx.invalidate();
        return null;
      },
    });
    const row = h.row("t", "x1");
    expect(() => row.setResult({ content: ["x"] })).toThrow(/render churn/);
  });

  test("identity theme passes text through untouched", () => {
    const theme = identityTheme();
    expect(theme.fg("accent", "a")).toBe("a");
    expect(theme.bg("errorBg", "b")).toBe("b");
    expect(theme.bold("c")).toBe("c");
  });
});

describe("cross-row invalidation", () => {
  test("rows invalidate each other without runaway when extension behaves", () => {
    const h = new PiHarness();
    // Two-row extension where each renderResult refreshes the OTHER row once
    // per genuine state change — well-behaved pattern, must terminate.
    const counts = new Map<string, number>();
    const defs: Record<string, ToolDefinition> = {};
    for (const [me, other] of [
      ["a", "b"],
      ["b", "a"],
    ] as const) {
      defs[me] = {
        name: me,
        renderCall: () => null,
        renderResult: () => {
          counts.set(me, (counts.get(me) ?? 0) + 1);
          return null;
        },
      };
      void other;
    }
    for (const def of Object.values(defs)) h.api.registerTool(def);

    const ra = h.row("a", "a");
    const rb = h.row("b", "b");
    ra.setArgs({});
    rb.setArgs({});
    ra.setResult({ content: ["x"] });
    rb.setResult({ content: ["y"] });
    // Each result rendered exactly once per row; no ping-pong escalation.
    expect(h.totalUpdates).toBeLessThan(20);
  });
});
