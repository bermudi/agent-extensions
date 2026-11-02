import { beforeEach, describe, expect, test } from "bun:test";
import { createFusion, type ConnectFn } from "./index.ts";
import { DIRECT_EDIT_NUDGE, SIDEKICK_DOCTRINE } from "./prompts.ts";
import type {
  ConnectOptions,
  HarnessId,
  Logger,
  SidekickConnector,
  TurnCallbacks,
  TurnOutcome,
} from "./types.ts";

// ---------- fakes ----------

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakeTool {
  name: string;
  defaultActive?: boolean;
  execute: (
    id: string,
    params: { message: string; block?: boolean },
    signal: AbortSignal | undefined,
    onUpdate: ((r: unknown) => void) | undefined,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

interface Entry {
  type: "custom";
  customType: string;
  data: unknown;
}

function makePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, FakeTool>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const entries: Entry[] = [];
  const sent: {
    message: { customType: string; content: string };
    options: unknown;
  }[] = [];
  let active: string[] = ["read", "bash", "edit", "write"];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    registerTool(tool: FakeTool) {
      tools.set(tool.name, tool);
      if (tool.defaultActive !== false) active = [...active, tool.name];
    },
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.set(name, options);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(
      message: { customType: string; content: string },
      options: unknown,
    ) {
      sent.push({ message, options });
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
  };
  const emit = async (event: string, payload: unknown, ctx: unknown) => {
    let result: unknown;
    for (const h of handlers.get(event) ?? [])
      result = (await h(payload, ctx)) ?? result;
    return result;
  };
  return {
    pi,
    tools,
    commands,
    entries,
    sent,
    emit,
    active: () => active,
  };
}

function makeCtx(selections: string[], entries: Entry[] = []) {
  const notes: { msg: string; level?: string }[] = [];
  const queue = [...selections];
  return {
    notes,
    ctx: {
      cwd: "/tmp/fusion-test",
      hasUI: true,
      ui: {
        select: async () => queue.shift(),
        confirm: async () => true,
        notify: (msg: string, level?: string) => notes.push({ msg, level }),
        setStatus: () => undefined,
      },
      sessionManager: { getBranch: () => entries },
    },
  };
}

class FakeConnector implements SidekickConnector {
  prompts: string[] = [];
  injected: string[] = [];
  disposed = false;
  private pending:
    { resolve: (o: TurnOutcome) => void; callbacks: TurnCallbacks } | undefined;
  constructor(
    readonly harness: HarnessId,
    readonly model: string,
    readonly sessionId: string,
  ) {}
  prompt(text: string, callbacks: TurnCallbacks): Promise<TurnOutcome> {
    this.prompts.push(text);
    return new Promise((resolve) => {
      this.pending = { resolve, callbacks };
    });
  }
  get running() {
    return this.pending !== undefined;
  }
  activity(text: string) {
    this.pending?.callbacks.onActivity({ kind: "tool", text });
  }
  finish(report: string, contextUsed = 50_000) {
    const p = this.pending;
    this.pending = undefined;
    p?.resolve({ report, stopReason: "end_turn", contextUsed });
  }
  async inject(text: string) {
    if (!this.pending) return false;
    this.injected.push(text);
    return true;
  }
  async cancel() {}
  async dispose() {
    this.disposed = true;
  }
}

const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function setup() {
  const made: FakeConnector[] = [];
  const calls: ConnectOptions[] = [];
  let counter = 0;
  let failResume = false;
  const make =
    (harness: HarnessId): ConnectFn =>
    async (options) => {
      calls.push(options);
      if (options.resumeSessionId && failResume) throw new Error("gone");
      const c = new FakeConnector(
        harness,
        options.model,
        options.resumeSessionId ?? `${harness}-s${++counter}`,
      );
      made.push(c);
      return c;
    };
  const fake = makePi();
  createFusion(fake.pi as never, {
    connectors: { piz: make("piz"), devin: make("devin") },
    log: silent,
  });
  return {
    ...fake,
    made,
    calls,
    setFailResume: (v: boolean) => {
      failResume = v;
    },
    tool: () => fake.tools.get("sidekick")!,
    run: (args: string, selections: string[]) => {
      const { ctx, notes } = makeCtx(selections);
      return fake.commands
        .get("fusion")!
        .handler(args, ctx)
        .then(() => notes);
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const text = (r: { content: { text: string }[] }) =>
  r.content.map((c) => c.text).join("\n");

// ---------- tests ----------

describe("activation", () => {
  test("sidekick tool is registered inactive (registration must not activate it)", () => {
    const s = setup();
    expect(s.tool().defaultActive).toBe(false);
    expect(s.active()).not.toContain("sidekick");
  });

  test("calling the tool while fusion is off fails", async () => {
    const s = setup();
    await expect(
      s
        .tool()
        .execute("t", { message: "x" }, undefined, undefined, { cwd: "/tmp" }),
    ).rejects.toThrow(/Fusion is off/);
  });

  test("piz asks for a model; devin (single model) does not", async () => {
    const s = setup();
    await s.run("", ["piz (GLM coding plan)", "GLM-5.3-Flash"]);
    expect(s.calls.at(-1)).toMatchObject({ model: "GLM-5.3-Flash" });
    expect(s.active()).toContain("sidekick");

    await s.run("", ["Devin (SWE-2)"]);
    expect(s.calls.at(-1)).toMatchObject({ model: "swe-2-medium" });
    expect(s.made[0]!.disposed).toBe(true); // switching disposes the previous sidekick
  });

  test("/fusion off removes the tool and stops the sidekick", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    await s.run("off", []);
    expect(s.active()).not.toContain("sidekick");
    expect(s.made[0]!.disposed).toBe(true);
    expect(s.entries.at(-1)!.data).toEqual({ enabled: false });
  });

  test("attaching queues a one-off 'new sidekick, re-brief fully' note for the lead", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const first = (await s.emit("before_agent_start", {}, {})) as {
      message?: { content: string };
    };
    expect(first.message?.content).toMatch(/NEW sidekick with no memory/);
    expect(await s.emit("before_agent_start", {}, {})).toBeUndefined();
  });
});

describe("handoffs", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup();
    await s.run("", ["Devin (SWE-2)"]);
  });

  test("blocking handoff returns the report; doctrine rides only on the first", async () => {
    const p = s
      .tool()
      .execute("t1", { message: "do A" }, undefined, undefined, {
        cwd: "/tmp",
      });
    await flush();
    const sk = s.made[0]!;
    expect(sk.prompts[0]).toContain(SIDEKICK_DOCTRINE.slice(0, 40));
    expect(sk.prompts[0]).toContain("do A");
    sk.finish("did A", 120_000);
    const r = await p;
    expect(text(r)).toContain("did A");
    expect(text(r)).toContain("sidekick context: 120K/262K");

    const p2 = s
      .tool()
      .execute("t2", { message: "do B" }, undefined, undefined, {
        cwd: "/tmp",
      });
    await flush();
    expect(sk.prompts[1]).toBe("do B");
    sk.finish("did B");
    await p2;
  });

  test("progress streams through onUpdate", async () => {
    const updates: string[] = [];
    const p = s
      .tool()
      .execute(
        "t",
        { message: "go" },
        undefined,
        (u) => updates.push(text(u as never)),
        {
          cwd: "/tmp",
        },
      );
    await flush();
    s.made[0]!.activity("Ran tests");
    s.made[0]!.finish("ok");
    await p;
    expect(updates.join("\n")).toContain("→ Ran tests");
  });

  test("block:false returns at once and delivers the report as a triggering message", async () => {
    const r = await s
      .tool()
      .execute("t", { message: "bg", block: false }, undefined, undefined, {
        cwd: "/tmp",
      });
    expect(text(r)).toMatch(/Handoff #1 started/);
    s.made[0]!.finish("bg done");
    await flush();
    await flush();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.message.content).toContain("bg done");
    expect(s.sent[0]!.options).toEqual({
      triggerTurn: true,
      deliverAs: "followUp",
    });
  });

  test("a call while running injects a <lead_update>, never a second handoff", async () => {
    await s
      .tool()
      .execute(
        "t1",
        { message: "long job", block: false },
        undefined,
        undefined,
        { cwd: "/tmp" },
      );
    const sk = s.made[0]!;
    const r = await s
      .tool()
      .execute(
        "t2",
        { message: "also X", block: false },
        undefined,
        undefined,
        {
          cwd: "/tmp",
        },
      );
    expect(text(r)).toMatch(/Update delivered into running handoff #1/);
    expect(sk.injected).toEqual(["<lead_update>\nalso X\n</lead_update>"]);
    expect(sk.prompts).toHaveLength(1);
    expect(s.made).toHaveLength(1);
  });

  test("a blocking update waits for the running handoff and takes over its report", async () => {
    await s
      .tool()
      .execute("t1", { message: "job", block: false }, undefined, undefined, {
        cwd: "/tmp",
      });
    const p = s
      .tool()
      .execute("t2", { message: "wrap up" }, undefined, undefined, {
        cwd: "/tmp",
      });
    await flush();
    s.made[0]!.finish("job done");
    expect(text(await p)).toContain("job done");
    await flush();
    expect(s.sent).toHaveLength(0); // not delivered twice
  });
});

describe("persistence", () => {
  test("session_start restores state and reattaches to the recorded sidekick session", async () => {
    const s = setup();
    const entries: Entry[] = [
      {
        type: "custom",
        customType: "fusion-state",
        data: {
          enabled: true,
          harness: "devin",
          model: "swe-2-medium",
          sidekickSessionId: "old-1",
          sidekickBriefed: true,
        },
      },
    ];
    const { ctx } = makeCtx([], entries);
    await s.emit("session_start", { reason: "resume" }, ctx);
    expect(s.active()).toContain("sidekick");
    const p = s
      .tool()
      .execute("t", { message: "continue" }, undefined, undefined, {
        cwd: "/tmp",
      });
    await flush();
    expect(s.calls.at(-1)!.resumeSessionId).toBe("old-1");
    expect(s.made[0]!.prompts[0]).toBe("continue"); // already briefed: no doctrine
    s.made[0]!.finish("ok");
    expect(text(await p)).not.toMatch(/NEW sidekick/);
  });

  test("a failed reattach falls back to a fresh, re-briefed sidekick and says so", async () => {
    const s = setup();
    s.setFailResume(true);
    const entries: Entry[] = [
      {
        type: "custom",
        customType: "fusion-state",
        data: {
          enabled: true,
          harness: "piz",
          model: "GLM-5.3",
          sidekickSessionId: "old-1",
          sidekickBriefed: true,
        },
      },
    ];
    await s.emit(
      "session_start",
      { reason: "resume" },
      makeCtx([], entries).ctx,
    );
    const p = s
      .tool()
      .execute("t", { message: "continue" }, undefined, undefined, {
        cwd: "/tmp",
      });
    await flush();
    await flush();
    const sk = s.made[0]!;
    expect(sk.sessionId).not.toBe("old-1");
    expect(sk.prompts[0]).toContain(SIDEKICK_DOCTRINE.slice(0, 40));
    sk.finish("ok");
    expect(text(await p)).toMatch(/NEW sidekick with no memory/);
  });

  test("a fork drops the parent's sidekick session id", async () => {
    const s = setup();
    const entries: Entry[] = [
      {
        type: "custom",
        customType: "fusion-state",
        data: {
          enabled: true,
          harness: "devin",
          model: "swe-2-medium",
          sidekickSessionId: "parent",
          sidekickBriefed: true,
        },
      },
    ];
    await s.emit("session_start", { reason: "fork" }, makeCtx([], entries).ctx);
    const p = s
      .tool()
      .execute("t", { message: "go" }, undefined, undefined, { cwd: "/tmp" });
    await flush();
    expect(s.calls.at(-1)!.resumeSessionId).toBeUndefined();
    s.made[0]!.finish("ok");
    await p;
  });

  test("unknown harness/model in saved state is ignored (stays off)", async () => {
    const s = setup();
    const entries: Entry[] = [
      {
        type: "custom",
        customType: "fusion-state",
        data: { enabled: true, harness: "devin", model: "claude-opus" },
      },
    ];
    await s.emit(
      "session_start",
      { reason: "resume" },
      makeCtx([], entries).ctx,
    );
    expect(s.active()).not.toContain("sidekick");
  });
});

describe("direct-edit nudge", () => {
  test("appended once per lead run, only while fusion is on", async () => {
    const s = setup();
    const edit = {
      toolName: "edit",
      isError: false,
      content: [{ type: "text", text: "ok" }],
    };
    expect(await s.emit("tool_result", edit, {})).toBeUndefined();
    await s.run("", ["Devin (SWE-2)"]);
    await s.emit("before_agent_start", {}, {});
    const r = (await s.emit("tool_result", edit, {})) as {
      content: { text: string }[];
    };
    expect(r.content.at(-1)!.text).toBe(DIRECT_EDIT_NUDGE);
    expect(await s.emit("tool_result", edit, {})).toBeUndefined();
    await s.emit("before_agent_start", {}, {});
    expect(await s.emit("tool_result", edit, {})).toBeDefined();
  });

  test("not for reads, errors, or nested calls", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    await s.emit("before_agent_start", {}, {});
    const base = { isError: false, content: [] };
    expect(
      await s.emit("tool_result", { ...base, toolName: "read" }, {}),
    ).toBeUndefined();
    expect(
      await s.emit(
        "tool_result",
        { ...base, toolName: "edit", isError: true },
        {},
      ),
    ).toBeUndefined();
    expect(
      await s.emit(
        "tool_result",
        { ...base, toolName: "edit", parentToolCallId: "p" },
        {},
      ),
    ).toBeUndefined();
  });
});
