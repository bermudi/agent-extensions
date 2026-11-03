import { beforeEach, describe, expect, test } from "bun:test";
import { createFusion, type ConnectFn } from "./fusion.ts";
import {
  DIRECT_EDIT_NUDGE,
  SIDEKICK_DOCTRINE,
  TREE_NAVIGATION_NOTE,
} from "./fusion-prompts.ts";
import type {
  ConnectOptions,
  HarnessId,
  Logger,
  SidekickConnector,
  TurnCallbacks,
  TurnOutcome,
} from "./fusion-types.ts";

// ---------- fakes ----------

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakeTool {
  name: string;
  description?: string;
  promptSnippet?: string;
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
  let appendHook: ((customType: string, data: unknown) => void) | undefined;
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
      appendHook?.(customType, data);
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
    setAppendHook: (
      hook: ((customType: string, data: unknown) => void) | undefined,
    ) => {
      appendHook = hook;
    },
  };
}

function makeCtx(
  selections: string[],
  entries: Entry[] = [],
  allEntries: Entry[] = entries,
) {
  const notes: { msg: string; level?: string }[] = [];
  const statuses = new Map<string, string>();
  const queue = [...selections];
  return {
    notes,
    statuses,
    ctx: {
      cwd: "/tmp/fusion-test",
      hasUI: true,
      ui: {
        select: async () => queue.shift(),
        confirm: async () => true,
        notify: (msg: string, level?: string) => notes.push({ msg, level }),
        setStatus: (key: string, text?: string) => {
          if (text === undefined) statuses.delete(key);
          else statuses.set(key, text);
        },
      },
      sessionManager: {
        getBranch: () => entries,
        getEntries: () => allEntries,
      },
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
  let failHarness: HarnessId | undefined;
  let remapResume = false;
  let gate: Promise<void> | undefined;
  let gateFilter: ((options: ConnectOptions) => boolean) | undefined;
  let lastStatuses = new Map<string, string>();
  let lastCtx: ReturnType<typeof makeCtx>["ctx"] | undefined;
  /** Runs inside the connect fn after the connector exists but before it is returned. */
  let onConnect: ((options: ConnectOptions) => void) | undefined;
  const make =
    (harness: HarnessId): ConnectFn =>
    async (options) => {
      calls.push(options);
      if (gate && (!gateFilter || gateFilter(options))) await gate;
      if (options.resumeSessionId && failResume) throw new Error("gone");
      if (harness === failHarness) throw new Error("connect refused");
      const c = new FakeConnector(
        harness,
        options.model,
        options.resumeSessionId && !remapResume
          ? options.resumeSessionId
          : `${harness}-s${++counter}`,
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
    setFailHarness: (h: HarnessId | undefined) => {
      failHarness = h;
    },
    setResumeRemap: (v: boolean) => {
      remapResume = v;
    },
    setOnConnect: (fn: ((options: ConnectOptions) => void) | undefined) => {
      onConnect = fn;
    },
    /** Hold every connect until the returned function is called. */
    holdConnects: (filter?: (options: ConnectOptions) => boolean) => {
      let open!: () => void;
      gateFilter = filter;
      gate = new Promise<void>((r) => {
        open = () => {
          gate = undefined;
          gateFilter = undefined;
          r();
        };
      });
      return open;
    },
    tool: () => fake.tools.get("sidekick")!,
    statuses: () => lastStatuses,
    /** The ctx the last s.run() handed to /fusion (fusion keeps it as uiCtx). */
    runCtx: () => {
      if (!lastCtx) throw new Error("no run yet");
      return lastCtx;
    },
    run: (args: string, selections: string[]) => {
      const { ctx, notes, statuses } = makeCtx(selections);
      lastCtx = ctx;
      lastStatuses = statuses;
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

  test("the tool metadata names Fusion so a searchTools('fusion') lookup finds it", () => {
    const s = setup();
    const tool = s.tool();
    expect(tool.description).toMatch(/fusion/i);
    expect(tool.description).toMatch(/sidekick/i);
    expect(tool.description).toMatch(/\/fusion/);
    expect(tool.promptSnippet).toMatch(/fusion/i);
    expect(tool.defaultActive).toBe(false);
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

  test("the status publishes the 'side:' badge contract for the footer", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    // provider-balance's footer folds "side:"-prefixed statuses into the
    // stats-line model readout; the plain status line is the fallback.
    expect(s.statuses().get("fusion")).toBe("side: SWE-2 Medium");
    await s.run("off", []);
    expect(s.statuses().get("fusion")).toBeUndefined();
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
    // Idle lead (ctx.signal unset): start a turn. The mid-run path and pi's
    // real queue behaviour are pinned in fusion-delivery.integration.test.ts.
    expect(s.sent[0]!.options).toEqual({
      triggerTurn: true,
      deliverAs: "steer",
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

const enabledEntry = (sessionId: string): Entry => ({
  type: "custom",
  customType: "fusion-state",
  data: {
    enabled: true,
    harness: "devin",
    model: "swe-2-medium",
    sidekickSessionId: sessionId,
    sidekickBriefed: true,
  },
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
    // The fork queues its own fresh-sidekick note (the session_start clear
    // must not eat the note the fork branch itself queues).
    const note = (await s.emit("before_agent_start", {}, {})) as {
      message?: { content: string };
    };
    expect(note.message?.content).toMatch(/NEW sidekick with no memory/);
    const p = s
      .tool()
      .execute("t", { message: "go" }, undefined, undefined, { cwd: "/tmp" });
    await flush();
    expect(s.calls.at(-1)!.resumeSessionId).toBeUndefined();
    s.made[0]!.finish("ok");
    await p;
  });

  test("a note queued before a session switch is not delivered in the resumed session", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]); // queues the "NEW sidekick" note
    // Switch sessions before the next lead run consumes that note.
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
    await s.emit(
      "session_start",
      { reason: "resume" },
      makeCtx([], entries).ctx,
    );
    // The resumed sidekick reattaches with its memory; the stale "NEW
    // sidekick with no memory" note from the previous session must not fire.
    expect(await s.emit("before_agent_start", {}, {})).toBeUndefined();
  });

  test("a note queued before switching into a disabled session is dropped, not held for the next enabled one", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]); // queues the "NEW sidekick" note
    await s.emit("session_start", { reason: "resume" }, makeCtx([]).ctx);
    expect(s.active()).not.toContain("sidekick");
    expect(await s.emit("before_agent_start", {}, {})).toBeUndefined();
    // Switch on into an enabled session: the note queued two sessions ago
    // must not surface here either (before_agent_start's early return on a
    // disabled session alone would have left it pending).
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
    await s.emit(
      "session_start",
      { reason: "resume" },
      makeCtx([], entries).ctx,
    );
    expect(await s.emit("before_agent_start", {}, {})).toBeUndefined();
  });

  for (const reason of ["resume", "reload"]) {
    test(`session_start restores the current branch's choice, not another branch's (${reason})`, async () => {
      const s = setup();
      // Enabled only on a branch the current point is not on: stays off.
      await s.emit(
        "session_start",
        { reason },
        makeCtx([], [], [enabledEntry("elsewhere")]).ctx,
      );
      expect(s.active()).not.toContain("sidekick");
    });

    test(`session_start reattaches the latest sidekick the session recorded for the branch's choice (${reason})`, async () => {
      const s = setup();
      await s.emit(
        "session_start",
        { reason },
        makeCtx(
          [],
          [enabledEntry("old-1")],
          [enabledEntry("old-1"), enabledEntry("newer")],
        ).ctx,
      );
      expect(s.active()).toContain("sidekick");
      const p = s
        .tool()
        .execute("t", { message: "continue" }, undefined, undefined, {
          cwd: "/tmp",
        });
      await flush();
      expect(s.calls.at(-1)!.resumeSessionId).toBe("newer");
      expect(s.made[0]!.prompts[0]).toBe("continue");
      s.made[0]!.finish("ok");
      expect(text(await p)).not.toMatch(/NEW sidekick/);
    });
  }
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

interface TreeEntry {
  id: string;
  parentId: string | null;
  type: string;
  customType?: string;
  data?: unknown;
  message?: { role: string; stopReason?: string };
}

/** A pi session tree: entries hang off the leaf; navigation moves the leaf. */
class FakeSession {
  entries: TreeEntry[] = [];
  leaf: string | null = null;
  private n = 0;
  add(entry: Omit<TreeEntry, "id" | "parentId">): string {
    const id = `e${++this.n}`;
    this.entries.push({ ...entry, id, parentId: this.leaf });
    this.leaf = id;
    return id;
  }
  user(): string {
    return this.add({ type: "message", message: { role: "user" } });
  }
  assistant(stopReason = "stop"): string {
    return this.add({
      type: "message",
      message: { role: "assistant", stopReason },
    });
  }
  /** A completed exchange; returns the assistant entry id. */
  turn(): string {
    this.user();
    return this.assistant();
  }
  parentOf(id: string): string | null {
    return this.entries.find((e) => e.id === id)!.parentId;
  }
  branch(fromId: string | null): TreeEntry[] {
    const path: TreeEntry[] = [];
    let id = fromId;
    while (id !== null) {
      const entry = this.entries.find((e) => e.id === id)!;
      path.unshift(entry);
      id = entry.parentId;
    }
    return path;
  }
  manager() {
    return {
      getBranch: (fromId?: string) => this.branch(fromId ?? this.leaf),
      getEntries: () => [...this.entries],
      getLeafId: () => this.leaf,
    };
  }
  states(): TreeEntry[] {
    return this.entries.filter((e) => e.customType === "fusion-state");
  }
}

describe("tree navigation", () => {
  const cwd = { cwd: "/tmp" };

  /** setup() whose appendEntry writes into a session tree. */
  const treeSetup = () => {
    const s = setup();
    const session = new FakeSession();
    s.setAppendHook((customType, data) =>
      session.add({ type: "custom", customType, data }),
    );
    // Like pi: navigating moves the leaf, restores the branch's tool loadout
    // (here: one without the sidekick, as in the bug report), then fires
    // session_tree.
    const navigate = async (to: string | null) => {
      const oldLeafId = session.leaf;
      session.leaf = to;
      s.pi.setActiveTools(["read", "bash", "grep"]);
      const c = makeCtx([]);
      const ctx = { ...c.ctx, sessionManager: session.manager() };
      await s.emit(
        "session_tree",
        { type: "session_tree", newLeafId: to, oldLeafId },
        ctx,
      );
      return c;
    };
    const resume = () =>
      s.emit(
        "session_start",
        { reason: "resume" },
        { ...makeCtx([]).ctx, sessionManager: session.manager() },
      );
    const nextNote = async () =>
      (
        (await s.emit("before_agent_start", {}, {})) as
          { message?: { content: string } } | undefined
      )?.message?.content;
    return { s, session, navigate, resume, nextNote };
  };

  test("navigating to a point before /fusion turns it off, with a notice", async () => {
    const { s, session, navigate, resume, nextNote } = treeSetup();
    const before = session.turn();
    await s.run("", ["Devin (SWE-2)"]);
    const sk = s.made[0]!;
    await nextNote(); // the attach note rode the next run
    session.turn();
    const statesBefore = session.states().length;

    const nav = await navigate(before);
    expect(s.active()).not.toContain("sidekick");
    expect(s.active()).toContain("grep");
    expect(sk.disposed).toBe(true);
    expect(nav.statuses.get("fusion")).toBeUndefined();
    expect(nav.notes.at(-1)!.msg).toMatch(
      /Fusion off: this point of the conversation had no sidekick/,
    );
    expect(await nextNote()).toBeUndefined();
    // The target's own state needs no snapshot.
    expect(session.states()).toHaveLength(statesBefore);
    // And it stays off at resume from here.
    await resume();
    expect(s.active()).not.toContain("sidekick");
  });

  test("navigating to the root of a session that enabled fusion later turns it off", async () => {
    const { s, session, navigate } = treeSetup();
    await s.run("", ["Devin (SWE-2)"]);
    session.turn();
    await navigate(null);
    expect(s.active()).not.toContain("sidekick");
  });

  for (const stopReason of ["error", "aborted"]) {
    test(`/fusion after a failed (${stopReason}) prompt carries over when that prompt is retried`, async () => {
      const { s, session, navigate, resume, nextNote } = treeSetup();
      session.turn();
      const failedPrompt = session.user();
      session.assistant(stopReason);
      await s.run("", ["Devin (SWE-2)"]);
      const sk = s.made[0]!;

      // Selecting a user message in /tree puts the leaf on its parent.
      const nav = await navigate(session.parentOf(failedPrompt));
      expect(s.active()).toContain("sidekick");
      expect(sk.disposed).toBe(false);
      expect(nav.statuses.get("fusion")).toBe("side: SWE-2 Medium");
      expect(nav.notes.at(-1)!.msg).toMatch(/Fusion stays on \(SWE-2 Medium\)/);
      // No run consumed /fusion's attach note yet; it is still the one queued.
      expect(await nextNote()).toMatch(/^Sidekick attached: .*NEW sidekick/);
      expect(await nextNote()).toBeUndefined();
      // Recorded on the new branch, so a resume from here keeps it.
      const snapshot = session.states().at(-1)!;
      expect(snapshot.parentId).toBe(session.parentOf(failedPrompt));
      expect(snapshot.data).toMatchObject({
        enabled: true,
        sidekickSessionId: sk.sessionId,
      });
      await resume();
      expect(s.active()).toContain("sidekick");
      const p = s
        .tool()
        .execute("t", { message: "go" }, undefined, undefined, cwd);
      await flush();
      expect(s.calls.at(-1)!.resumeSessionId).toBe(sk.sessionId);
      s.made.at(-1)!.finish("ok");
      await p;
    });

    test(`a failed (${stopReason}) turn after /fusion is noise too`, async () => {
      const { s, session, navigate, nextNote } = treeSetup();
      const before = session.turn();
      await s.run("", ["Devin (SWE-2)"]);
      session.user();
      // The failed run consumed the attach note; it lives on the tail we leave.
      expect(await nextNote()).toMatch(/^Sidekick attached:/);
      session.assistant(stopReason);
      await navigate(before);
      expect(s.active()).toContain("sidekick");
      expect(s.made[0]!.disposed).toBe(false);
      // The new branch never saw it, so the lead is introduced to it again.
      expect(await nextNote()).toBe(
        "Sidekick attached: Devin (SWE-2) · SWE-2 Medium. This is a NEW sidekick with no memory of earlier work in this session; brief it fully, including any context a previous sidekick had.",
      );
    });
  }

  test("an explicit off with nothing completed after it stays off", async () => {
    const { s, session, navigate } = treeSetup();
    await s.run("", ["Devin (SWE-2)"]);
    const last = session.turn();
    await s.run("off", []);
    const nav = await navigate(last);
    expect(s.active()).not.toContain("sidekick");
    expect(nav.notes.at(-1)!.msg).toMatch(/Fusion stays off/);
    expect(session.states().at(-1)!.data).toEqual({ enabled: false });
    expect(s.calls).toHaveLength(1);
  });

  test("navigating back to a fusion point after real turns with it off re-enables it and reattaches the sidekick", async () => {
    const { s, session, navigate, nextNote } = treeSetup();
    await s.run("", ["Devin (SWE-2)"]);
    const sk = s.made[0]!;
    await nextNote();
    const onPoint = session.turn();
    await s.run("off", []);
    session.turn();

    const nav = await navigate(onPoint);
    expect(s.active()).toContain("sidekick");
    expect(nav.statuses.get("fusion")).toBe("side: SWE-2 Medium");
    expect(nav.notes.at(-1)!.msg).toMatch(/Fusion on \(SWE-2 Medium\)/);
    expect(await nextNote()).toMatch(/restored by navigation/);
    const p = s
      .tool()
      .execute("t", { message: "go" }, undefined, undefined, cwd);
    await flush();
    expect(s.calls.at(-1)!.resumeSessionId).toBe(sk.sessionId);
    s.made.at(-1)!.finish("ok");
    expect(text(await p)).not.toMatch(/NEW sidekick/);
  });

  test("navigating to before a sidekick swap switches back to the earlier sidekick", async () => {
    const { s, session, navigate } = treeSetup();
    await s.run("", ["Devin (SWE-2)"]);
    const devinPoint = session.turn();
    await s.run("", ["piz (GLM coding plan)", "GLM-5.3"]);
    const piz = s.made.at(-1)!;
    expect(piz.harness).toBe("piz");
    session.turn();

    const nav = await navigate(devinPoint);
    expect(piz.disposed).toBe(true);
    expect(nav.statuses.get("fusion")).toBe("side: SWE-2 Medium");
    expect(nav.notes.at(-1)!.msg).toMatch(/Fusion switched to SWE-2 Medium/);
    const p = s
      .tool()
      .execute("t", { message: "go" }, undefined, undefined, cwd);
    await flush();
    expect(s.calls.at(-1)!.resumeSessionId).toBe(s.made[0]!.sessionId);
    s.made.at(-1)!.finish("ok");
    await p;
  });

  test("navigation within the fusion era reapplies the tool, keeps the live sidekick, and writes nothing", async () => {
    const { s, session, navigate, nextNote } = treeSetup();
    await s.run("", ["Devin (SWE-2)"]);
    const sk = s.made[0]!;
    await nextNote();
    const early = session.turn();
    const h = s
      .tool()
      .execute("t1", { message: "job" }, undefined, undefined, cwd);
    await flush();
    sk.finish("done");
    await h;
    session.turn();
    const statesBefore = session.states().length;

    const nav = await navigate(early);
    expect(s.active()).toContain("sidekick");
    expect(s.active()).toContain("grep");
    expect(s.calls).toHaveLength(1);
    expect(sk.disposed).toBe(false);
    expect(session.states()).toHaveLength(statesBefore);
    expect(nav.notes).toHaveLength(0);
    expect(nav.statuses.get("fusion")).toBe("side: SWE-2 Medium");
    expect(
      s.events.some(
        (e) => e.event === "fusion.tree_synced" && e.data?.decision === "same",
      ),
    ).toBe(true);
    const p = s
      .tool()
      .execute("t2", { message: "more" }, undefined, undefined, cwd);
    await flush();
    expect(s.calls).toHaveLength(1);
    expect(sk.prompts[1]).toBe("more");
    sk.finish("more done");
    await p;
    expect(await nextNote()).toBe(TREE_NAVIGATION_NOTE);
    expect(await nextNote()).toBeUndefined();
  });

  test("a pending background handoff survives navigation that keeps fusion on, delivered once", async () => {
    const { s, session, navigate } = treeSetup();
    await s.run("", ["Devin (SWE-2)"]);
    const sk = s.made[0]!;
    const early = session.turn();
    await s
      .tool()
      .execute("t", { message: "bg", block: false }, undefined, undefined, cwd);
    session.turn();
    const nav = await navigate(early);
    expect(sk.disposed).toBe(false);
    expect(s.active()).toContain("sidekick");
    expect(nav.statuses.get("fusion")).toBe("side: SWE-2 Medium ⏳");
    sk.finish("bg done");
    await flush();
    await flush();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.message.content).toContain("bg done");
    expect(nav.statuses.get("fusion")).toBe("side: SWE-2 Medium");
  });

  test("navigation that turns fusion off stops a running handoff and says so; its report never lands", async () => {
    const { s, session, navigate } = treeSetup();
    const before = session.turn();
    await s.run("", ["Devin (SWE-2)"]);
    const sk = s.made[0]!;
    session.turn();
    await s
      .tool()
      .execute("t", { message: "bg", block: false }, undefined, undefined, cwd);
    const nav = await navigate(before);
    expect(sk.disposed).toBe(true);
    expect(nav.notes.at(-1)!.msg).toMatch(/Handoff #1 stopped/);
    sk.finish("late");
    await flush();
    await flush();
    expect(s.sent).toHaveLength(0);
  });

  test("a queued 'NEW sidekick' note survives a navigation that keeps fusion on", async () => {
    const { s, session, navigate, nextNote } = treeSetup();
    await s.run("", ["Devin (SWE-2)"]);
    const onPoint = session.leaf;
    session.user();
    session.assistant("error");
    await navigate(onPoint);
    expect(await nextNote()).toMatch(/NEW sidekick with no memory/);
    expect(await nextNote()).toBeUndefined();
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
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await fs.mkdtemp(join(tmpdir(), "fusion-ro-"));
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
    // Same delivery as a report: a failure must reach a working lead promptly.
    expect(s.sent[0]!.options).toEqual({
      triggerTurn: true,
      deliverAs: "steer",
    });
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

  // pi invalidates the extension ctx during /reload while detached work can
  // still be in flight; every ctx-bound call then throws (crash class of
  // 2026-11-02 — an unhandled rejection kills the whole TUI, since pi
  // installs no unhandledRejection handler).
  const staleCtxError = () =>
    new Error(
      "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
    );

  function trackUnhandledRejections(): {
    caught: unknown[];
    stop: () => void;
  } {
    const caught: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      caught.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    return {
      caught,
      stop: () => process.off("unhandledRejection", onUnhandled),
    };
  }

  test("a late onClosed on a stale ctx is logged, never an unhandled rejection", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    s.runCtx().ui.setStatus = () => {
      throw staleCtxError();
    };
    const unhandled = trackUnhandledRejections();
    try {
      s.calls[0]!.onClosed!(new Error("late death"));
      await flush();
      await flush();
      expect(
        s.events.some((e) => e.event === "sidekick.connector_dropped"),
      ).toBe(true);
      expect(
        s.events.some(
          (e) =>
            e.event === "sidekick.detached_failed" &&
            e.data?.what === "drop_connector",
        ),
      ).toBe(true);
      expect(unhandled.caught).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  test("a handoff report delivered after /reload does not reject detached", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    await s
      .tool()
      .execute(
        "t",
        { message: "job", block: false },
        undefined,
        undefined,
        cwd,
      );
    await flush();
    // /reload lands: every pi-bound call in the delivery chain now throws.
    const pi = s.pi as unknown as {
      sendMessage: (message: unknown, options: unknown) => void;
    };
    pi.sendMessage = () => {
      throw staleCtxError();
    };
    const unhandled = trackUnhandledRejections();
    try {
      s.made[0]!.finish("late report");
      await flush();
      await flush();
      expect(
        s.events.some(
          (e) =>
            e.event === "sidekick.detached_failed" &&
            e.data?.what === "handoff_delivery",
        ),
      ).toBe(true);
      expect(s.sent).toHaveLength(0);
      expect(unhandled.caught).toEqual([]);
    } finally {
      unhandled.stop();
    }
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

describe("shared startup transaction", () => {
  const cwd = { cwd: "/tmp" };

  test("off during a gated initial attach keeps fusion off and disposes the late connector", async () => {
    const s = setup();
    const open = s.holdConnects();
    const p = s.run("", ["Devin (SWE-2)"]);
    await flush();
    const offNotes = await s.run("off", []);
    open();
    const notes = await p;
    expect(s.made).toHaveLength(1);
    expect(s.made[0]!.disposed).toBe(true);
    expect(s.active()).not.toContain("sidekick");
    const status = await s.run("status", []);
    expect(status.at(-1)!.msg).toBe("Fusion is off.");
    expect(offNotes.at(-1)!.msg).toMatch(/already off/);
    expect(notes.some((n) => n.msg.includes("ready"))).toBe(false);
    expect(notes.some((n) => n.level === "error")).toBe(false);
  });

  test("a tool call during a picker swap waits for the new sidekick instead of resuming the old", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const first = s.made[0]!;
    const open = s.holdConnects();
    const swap = s.run("", ["piz (GLM coding plan)", "GLM-5.3"]);
    await flush();
    await flush();
    const tp = s
      .tool()
      .execute("t", { message: "go" }, undefined, undefined, cwd);
    await flush();
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]!.model).toBe("GLM-5.3");
    expect(s.calls[1]!.resumeSessionId).toBeUndefined();
    open();
    await swap;
    await flush();
    const picked = s.made[1]!;
    expect(picked.prompts[0]).toContain(SIDEKICK_DOCTRINE.slice(0, 40));
    expect(picked.prompts[0]).toContain("go");
    for (const c of s.made) c.finish("did it");
    const r = await tp;
    expect(text(r)).toContain("did it");
    expect(text(r)).toMatch(/NEW sidekick with no memory/);
    expect(first.disposed).toBe(true);
    await s.run("off", []);
    expect(picked.disposed).toBe(true);
    expect(s.made).toHaveLength(2);
  });

  for (const block of [true, false]) {
    test(`a failed swap keeps the prior model; the next call is a fresh NEW sidekick (block:${block})`, async () => {
      const s = setup();
      await s.run("", ["Devin (SWE-2)"]);
      await s.emit("before_agent_start", {}, {});
      const first = s.made[0]!;
      const hp = s
        .tool()
        .execute("t0", { message: "job" }, undefined, undefined, cwd);
      await flush();
      first.finish("done");
      await hp;
      s.setFailHarness("piz");
      const notes = await s.run("", ["piz (GLM coding plan)", "GLM-5.3"]);
      expect(notes.at(-1)!.msg).toMatch(/could not start GLM-5\.3/);
      expect(first.disposed).toBe(true);
      const tp = s
        .tool()
        .execute("t1", { message: "again", block }, undefined, undefined, cwd);
      await flush();
      const fresh = s.made[1]!;
      expect(fresh.harness).toBe("devin");
      expect(fresh.prompts[0]).toContain(SIDEKICK_DOCTRINE.slice(0, 40));
      fresh.finish("back");
      const r = await tp;
      expect(text(r)).toMatch(/NEW sidekick with no memory/);
    });
  }

  test("a resume that lands on a different session id is a NEW sidekick for both waiters", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const first = s.made[0]!;
    const h1 = s
      .tool()
      .execute("t0", { message: "a" }, undefined, undefined, cwd);
    await flush();
    first.finish("done", 88_000);
    await h1;
    s.calls[0]!.onClosed!(new Error("devin acp exited (1)"));
    s.setResumeRemap(true);
    const open = s.holdConnects();
    const p1 = s
      .tool()
      .execute("t1", { message: "b" }, undefined, undefined, cwd);
    const p2 = s
      .tool()
      .execute("t2", { message: "c" }, undefined, undefined, cwd);
    await flush();
    open();
    await flush();
    const resumed = s.made[1]!;
    expect(s.made).toHaveLength(2);
    expect(resumed.sessionId).not.toBe(first.sessionId);
    expect(resumed.prompts[0]).toContain(SIDEKICK_DOCTRINE.slice(0, 40));
    const notes = await s.run("status", []);
    expect(notes.at(-1)!.msg).toContain("context unknown");
    resumed.finish("ok");
    const r1 = await p1;
    const r2 = await p2;
    expect(text(r1)).toMatch(/NEW sidekick with no memory/);
    expect(text(r2)).toMatch(/NEW sidekick with no memory/);
  });

  test("a stale swap failure settling after off + reattach does not clobber the new sidekick", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const openOld = s.holdConnects((o) => o.model === "GLM-5.3");
    const swap = s.run("", ["piz (GLM coding plan)", "GLM-5.3"]);
    await flush();
    await flush();
    expect(s.calls).toHaveLength(2);
    await s.run("off", []);
    const p2 = s.run("", ["Devin (SWE-2)"]);
    await flush();
    expect(s.made).toHaveLength(2);
    const current = s.made[1]!;
    expect(current.harness).toBe("devin");
    const hp = s
      .tool()
      .execute("t0", { message: "job" }, undefined, undefined, cwd);
    await flush();
    current.finish("done");
    await hp;
    await flush();
    const states = () =>
      s.entries.filter((e) => e.customType === "fusion-state");
    const saved = states().at(-1)!.data;
    expect(saved).toMatchObject({
      enabled: true,
      harness: "devin",
      sidekickSessionId: current.sessionId,
      sidekickBriefed: true,
    });
    s.setFailHarness("piz");
    openOld();
    const staleNotes = await swap;
    await p2;
    await flush();
    await flush();
    expect(staleNotes.at(-1)!.msg).toContain("Starting sidekick");
    expect(staleNotes.some((n) => n.level === "error")).toBe(false);
    expect(states().at(-1)!.data).toEqual(saved);
    expect(s.active()).toContain("sidekick");
    expect(current.disposed).toBe(false);
    const tp = s
      .tool()
      .execute("t1", { message: "more" }, undefined, undefined, cwd);
    await flush();
    current.finish("more done");
    expect(text(await tp)).toContain("more done");
    expect(s.made).toHaveLength(2);
  });

  test("a tool call waiting on a failed swap rejects once; the next call lazily reconnects the prior model", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const first = s.made[0]!;
    const open = s.holdConnects();
    const swap = s.run("", ["piz (GLM coding plan)", "GLM-5.3"]);
    await flush();
    await flush();
    const tp = s
      .tool()
      .execute("t", { message: "go" }, undefined, undefined, cwd);
    tp.catch(() => undefined);
    await flush();
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]!.model).toBe("GLM-5.3");
    expect(s.calls[1]!.resumeSessionId).toBeUndefined();
    s.setFailHarness("piz");
    open();
    const swapNotes = await swap;
    await expect(tp).rejects.toThrow(/connect refused/);
    expect(swapNotes.some((n) => n.level === "error")).toBe(true);
    expect(first.disposed).toBe(true);
    expect(s.active()).toContain("sidekick");
    const latest = s.entries
      .filter((e) => e.customType === "fusion-state")
      .at(-1)!.data as {
      enabled: boolean;
      harness?: string;
      model?: string;
      sidekickSessionId?: string;
      sidekickBriefed?: boolean;
    };
    expect(latest.enabled).toBe(true);
    expect(latest.harness).toBe("devin");
    expect(latest.model).toBe("swe-2-medium");
    expect(latest.sidekickSessionId).toBeUndefined();
    expect(latest.sidekickBriefed).toBe(false);
    expect(s.calls).toHaveLength(2);
    const tp2 = s
      .tool()
      .execute("t2", { message: "again" }, undefined, undefined, cwd);
    await flush();
    expect(s.calls).toHaveLength(3);
    expect(s.calls[2]!.model).toBe("swe-2-medium");
    expect(s.calls[2]!.resumeSessionId).toBeUndefined();
    const fresh = s.made[1]!;
    expect(fresh.prompts[0]).toContain(SIDEKICK_DOCTRINE.slice(0, 40));
    fresh.finish("back");
    expect(text(await tp2)).toMatch(/NEW sidekick with no memory/);
    expect(s.made).toHaveLength(2);
  });

  test("off before a deferred swap disposal resolves admits no startup through the teardown window", async () => {
    const s = setup();
    await s.run("", ["Devin (SWE-2)"]);
    const first = s.made[0]!;
    let release!: () => void;
    const disposed = new Promise<void>((r) => {
      release = r;
    });
    first.dispose = () => disposed;
    const swap = s.run("", ["piz (GLM coding plan)", "GLM-5.3"]);
    await flush();
    await flush();
    const tp = s
      .tool()
      .execute("t", { message: "go" }, undefined, undefined, cwd);
    tp.catch(() => undefined);
    await flush();
    const offNotes = await s.run("off", []);
    release();
    await swap;
    for (const c of s.made) c.finish("stale");
    await expect(tp).rejects.toThrow(
      /Fusion changed while the sidekick was starting/,
    );
    expect(s.calls).toHaveLength(1);
    expect(offNotes.at(-1)!.msg).toMatch(/Fusion off/);
    expect(s.entries.at(-1)!.data).toEqual({ enabled: false });
    expect(s.active()).not.toContain("sidekick");
  });
});
