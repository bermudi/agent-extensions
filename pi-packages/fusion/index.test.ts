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
    | {
        resolve: (o: TurnOutcome) => void;
        reject: (e: Error) => void;
        callbacks: TurnCallbacks;
      }
    | undefined;
  /** What inject() answers while a turn runs. */
  injectResult = true;
  constructor(
    readonly harness: HarnessId,
    readonly model: string,
    readonly sessionId: string,
  ) {}
  prompt(text: string, callbacks: TurnCallbacks): Promise<TurnOutcome> {
    this.prompts.push(text);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, callbacks };
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
  fail(error: Error) {
    const p = this.pending;
    this.pending = undefined;
    p?.reject(error);
  }
  async inject(text: string) {
    if (!this.pending) return false;
    this.injected.push(text);
    return this.injectResult;
  }
  async cancel() {}
  async dispose() {
    this.disposed = true;
  }
}

function setup() {
  const made: FakeConnector[] = [];
  const calls: ConnectOptions[] = [];
  const events: {
    level: string;
    event: string;
    data?: Record<string, unknown>;
  }[] = [];
  const log: Logger = {
    info: (event, data) => events.push({ level: "info", event, data }),
    warn: (event, data) => events.push({ level: "warn", event, data }),
    error: (event, data) => events.push({ level: "error", event, data }),
  };
  let counter = 0;
  let failResume = false;
  let gate: Promise<void> | undefined;
  /** Runs inside the connect fn after the connector exists but before it is returned. */
  let onConnect: ((options: ConnectOptions) => void) | undefined;
  const make =
    (harness: HarnessId): ConnectFn =>
    async (options) => {
      calls.push(options);
      if (gate) await gate;
      if (options.resumeSessionId && failResume) throw new Error("gone");
      const c = new FakeConnector(
        harness,
        options.model,
        options.resumeSessionId ?? `${harness}-s${++counter}`,
      );
      made.push(c);
      onConnect?.(options);
      return c;
    };
  const fake = makePi();
  createFusion(fake.pi as never, {
    connectors: { piz: make("piz"), devin: make("devin") },
    log,
  });
  return {
    ...fake,
    made,
    calls,
    events,
    setFailResume: (v: boolean) => {
      failResume = v;
    },
    setOnConnect: (fn: ((options: ConnectOptions) => void) | undefined) => {
      onConnect = fn;
    },
    /** Hold every connect until the returned function is called. */
    holdConnects: () => {
      let open!: () => void;
      gate = new Promise<void>((r) => {
        open = () => {
          gate = undefined;
          r();
        };
      });
      return open;
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

describe("review fixes", () => {
  const cwd = { cwd: "/tmp" };

  test("a connector that dies on its own is dropped; the next call reattaches to the recorded session", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const first = s.made[0]!;
    s.calls[0]!.onClosed!(new Error("devin acp exited (1)"));
    expect(first.disposed).toBe(true); // dropConnector disposes the dead object
    const p = s
      .tool()
      .execute("t", { message: "again" }, undefined, undefined, cwd);
    await flush();
    expect(s.made).toHaveLength(2);
    expect(s.calls.at(-1)!.resumeSessionId).toBe(first.sessionId);
    s.made[1]!.finish("ok");
    await p;
  });

  test("/fusion off during a pending start disposes the late connector and installs nothing", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const open = s.holdConnects();
    s.calls[0]!.onClosed!(new Error("dead")); // force a reconnect on next use
    const p = s
      .tool()
      .execute("t", { message: "go" }, undefined, undefined, cwd);
    p.catch(() => undefined);
    await flush();
    await s.run("off", []);
    open();
    await expect(p).rejects.toThrow(
      /Fusion changed while the sidekick was starting/,
    );
    expect(s.made.at(-1)!.disposed).toBe(true);
    expect(s.active()).not.toContain("sidekick");
    expect(s.entries.at(-1)!.data).toEqual({ enabled: false });
  });

  test("a rejected first handoff does not mark the sidekick briefed", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const sk = s.made[0]!;
    const p = s
      .tool()
      .execute("t1", { message: "A" }, undefined, undefined, cwd);
    await flush();
    sk.fail(new Error("send failed"));
    await expect(p).rejects.toThrow("send failed");
    await flush();
    const p2 = s
      .tool()
      .execute("t2", { message: "B" }, undefined, undefined, cwd);
    await flush();
    expect(sk.prompts[1]).toContain(SIDEKICK_DOCTRINE.slice(0, 40));
    sk.finish("ok");
    await p2;
    await flush();
    const last = s.entries
      .filter((e) => e.customType === "fusion-state")
      .at(-1)!;
    expect((last.data as { sidekickBriefed?: boolean }).sidekickBriefed).toBe(
      true,
    );
  });

  test("an already-aborted signal never starts the handoff", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const ac = new AbortController();
    ac.abort();
    await expect(
      s.tool().execute("t", { message: "x" }, ac.signal, undefined, cwd),
    ).rejects.toThrow(/Cancelled/);
    expect(s.made[0]!.prompts).toHaveLength(0);
  });

  test("a blocking takeover claims the report before the inject round-trip (no double delivery)", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const sk = s.made[0]!;
    await s
      .tool()
      .execute(
        "t1",
        { message: "job", block: false },
        undefined,
        undefined,
        cwd,
      );
    const realInject = sk.inject.bind(sk);
    sk.inject = async (t: string) => {
      const answer = await realInject(t);
      sk.finish("done during inject"); // the handoff ends while the inject is in flight
      await flush();
      return answer;
    };
    const r = await s
      .tool()
      .execute("t2", { message: "wrap up" }, undefined, undefined, cwd);
    await flush();
    expect(text(r)).toContain("done during inject");
    expect(s.sent).toHaveLength(0);
  });

  test("an update the sidekick could not take is reported as not delivered", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const sk = s.made[0]!;
    await s
      .tool()
      .execute(
        "t1",
        { message: "job", block: false },
        undefined,
        undefined,
        cwd,
      );
    sk.injectResult = false;
    const p = s
      .tool()
      .execute("t2", { message: "late" }, undefined, undefined, cwd);
    await flush();
    sk.finish("job done");
    const out = text(await p);
    expect(out).toMatch(/update was NOT delivered/);
    expect(out).toContain("job done");
  });

  test("an oversized report survives a failed save", async () => {
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp("/tmp/fusion-probe/ro-");
    const file = `${dir}/not-a-dir`;
    await Bun.write(file, "x");
    const previous = process.env.FUSION_LOG_DIR;
    process.env.FUSION_LOG_DIR = file; // mkdir under a regular file -> ENOTDIR
    try {
      const s = setup();
      await s.run("", ["Devin (SWE-2)"]);
      const p = s
        .tool()
        .execute("t", { message: "big" }, undefined, undefined, cwd);
      await flush();
      s.made[0]!.finish("y".repeat(41_000));
      const out = text(await p);
      expect(out).toMatch(/the full text could not be saved/);
      expect(out.length).toBeGreaterThan(40_000);
    } finally {
      if (previous === undefined) delete process.env.FUSION_LOG_DIR;
      else process.env.FUSION_LOG_DIR = previous;
    }
  });
});

describe("teardown invalidation", () => {
  const cwd = { cwd: "/tmp" };
  const teardowns: [string, (s: ReturnType<typeof setup>) => Promise<void>][] =
    [
      ["off", async (s) => void (await s.run("off", []))],
      [
        "swap",
        async (s) =>
          void (await s.run("", ["piz (GLM coding plan)", "GLM-5.3"])),
      ],
      [
        "shutdown",
        async (s) => void (await s.emit("session_shutdown", {}, {})),
      ],
      [
        "session_start",
        async (s) =>
          void (await s.emit(
            "session_start",
            { reason: "new" },
            makeCtx([]).ctx,
          )),
      ],
    ];

  for (const [name, teardown] of teardowns) {
    test(`a late report after ${name} is not delivered`, async () => {
      const s = setup();
      await s.run("", ["Devin (SWE-2)"]);
      await s
        .tool()
        .execute(
          "t",
          { message: "bg", block: false },
          undefined,
          undefined,
          cwd,
        );
      await teardown(s);
      s.made[0]!.finish("stale report");
      await flush();
      await flush();
      expect(s.sent).toHaveLength(0);
    });

    test(`a turn rejection raised during ${name} teardown is not delivered`, async () => {
      const s = setup();
      await s.run("", ["Devin (SWE-2)"]);
      await s
        .tool()
        .execute(
          "t",
          { message: "bg", block: false },
          undefined,
          undefined,
          cwd,
        );
      const sk = s.made[0]!;
      // Real connectors reject the running turn while tearing down; the
      // rejection arrives inside dispose(), under the already-bumped epoch.
      const realDispose = sk.dispose.bind(sk);
      sk.dispose = async () => {
        sk.fail(new Error("sidekick shut down"));
        await realDispose();
      };
      await teardown(s);
      expect(s.sent).toHaveLength(0);
      await flush();
      await flush();
      expect(s.sent).toHaveLength(0);
    });
  }

  test("an old session's completion after new state is restored delivers nothing and marks nothing briefed", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const old = s.made[0]!;
    await s
      .tool()
      .execute("t", { message: "bg", block: false }, undefined, undefined, cwd);
    const entriesBefore = s.entries.length;
    const restored: Entry[] = [
      {
        type: "custom",
        customType: "fusion-state",
        data: {
          enabled: true,
          harness: "devin",
          model: "swe-2-medium",
          // Same session id as the stale connector: only the epoch can tell
          // this outcome belongs to the previous session.
          sidekickSessionId: old.sessionId,
          sidekickBriefed: false,
        },
      },
    ];
    await s.emit(
      "session_start",
      { reason: "resume" },
      makeCtx([], restored).ctx,
    );
    old.finish("stale report");
    await flush();
    await flush();
    expect(s.sent).toHaveLength(0);
    // A stale success must not mark the restored sidekick briefed.
    expect(s.entries.length).toBe(entriesBefore);
  });

  test("a genuine background failure (no teardown) still delivers its error", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    await s
      .tool()
      .execute("t", { message: "bg", block: false }, undefined, undefined, cwd);
    // The transport drops the connector and rejects the pending turn.
    s.calls[0]!.onClosed!(new Error("devin acp exited (1)"));
    s.made[0]!.fail(new Error("transport gone"));
    await flush();
    await flush();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.message.content).toContain(
      "Sidekick handoff #1 failed: transport gone",
    );
  });
});

describe("connector drop and early close", () => {
  const cwd = { cwd: "/tmp" };

  test("a stale connector's late onClosed disposes it (cleanup failures logged) without touching the current one", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const old = s.made[0]!;
    await s.run("", ["piz (GLM coding plan)", "GLM-5.3"]); // swap: old no longer current
    const current = s.made[1]!;
    old.dispose = () => Promise.reject(new Error("cleanup broke"));
    s.calls[0]!.onClosed!(new Error("late death"));
    await flush();
    await flush();
    expect(s.events.some((e) => e.event === "sidekick.connector_dropped")).toBe(
      true,
    );
    expect(
      s.events.some((e) => e.event === "sidekick.drop_cleanup_failed"),
    ).toBe(true);
    // The current connector is untouched and still serves handoffs.
    const p = s
      .tool()
      .execute("t", { message: "ok" }, undefined, undefined, cwd);
    await flush();
    current.finish("fine");
    expect(text(await p)).toContain("fine");
  });

  test("a connector whose transport dies during connect is disposed and never installed", async () => {
    const s = setup();
    s.setOnConnect((opts) => opts.onClosed?.(new Error("died during connect")));
    const notes = await s.run("", ["Devin (SWE-2)"]);
    expect(notes.at(-1)!.msg).toMatch(
      /could not start.*transport closed during startup/,
    );
    expect(s.made[0]!.disposed).toBe(true);
    expect(s.active()).not.toContain("sidekick");
  });
});

describe("context status", () => {
  const cwd = { cwd: "/tmp" };

  test("status shows last reported context; unknown before any measurement, zero counts, reset on swap, stale cannot restore", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    let notes = await s.run("status", []);
    expect(notes.at(-1)!.msg).toContain("context unknown");

    const p1 = s
      .tool()
      .execute("t1", { message: "a" }, undefined, undefined, cwd);
    await flush();
    s.made[0]!.finish("done", 0);
    await p1;
    notes = await s.run("status", []);
    expect(notes.at(-1)!.msg).toContain("context 0K/262K");

    const p2 = s
      .tool()
      .execute("t2", { message: "b" }, undefined, undefined, cwd);
    await flush();
    s.made[0]!.finish("done", 120_000);
    await p2;
    notes = await s.run("status", []);
    expect(notes.at(-1)!.msg).toContain("context 120K/262K");

    // A handoff still in flight across a swap cannot leave its measurement.
    await s
      .tool()
      .execute(
        "t3",
        { message: "bg", block: false },
        undefined,
        undefined,
        cwd,
      );
    await s.run("", ["piz (GLM coding plan)", "GLM-5.3"]);
    s.made[0]!.finish("stale", 200_000);
    await flush();
    await flush();
    notes = await s.run("status", []);
    expect(notes.at(-1)!.msg).toContain("context unknown");
  });

  test("a reattach to the same session id keeps the last measurement; a fresh replacement resets it", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const p1 = s
      .tool()
      .execute("t1", { message: "a" }, undefined, undefined, cwd);
    await flush();
    s.made[0]!.finish("done", 88_000);
    await p1;

    // Transport dies; the next handoff reattaches to the same session id and
    // the measurement survives.
    s.calls[0]!.onClosed!(new Error("devin acp exited (1)"));
    const p2 = s
      .tool()
      .execute("t2", { message: "b" }, undefined, undefined, cwd);
    await flush();
    expect(s.calls.at(-1)!.resumeSessionId).toBe(s.made[0]!.sessionId);
    let notes = await s.run("status", []);
    expect(notes.at(-1)!.msg).toContain("context 88K/262K");
    s.made[1]!.finish("done2", 10_000);
    await p2;

    // A failed reattach lands on a NEW session id: nothing was measured there.
    s.calls.at(-1)!.onClosed!(new Error("dead again"));
    s.setFailResume(true);
    const p3 = s
      .tool()
      .execute("t3", { message: "c" }, undefined, undefined, cwd);
    await flush();
    await flush();
    notes = await s.run("status", []);
    expect(notes.at(-1)!.msg).toContain("context unknown");
    s.made[2]!.finish("done3", 5_000);
    await p3;
    notes = await s.run("status", []);
    expect(notes.at(-1)!.msg).toContain("context 5K/262K");
  });
});
