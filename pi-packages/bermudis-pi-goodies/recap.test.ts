import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setGoodiesLogPathForTesting } from "./goodies-log.ts";
import {
  __setConfigPathForTesting,
  setRecapModel,
  setRecapTurns,
} from "./goodies.ts";
import recapExtension, {
  RECAP_ENTRY_TYPE,
  RECAP_MAX_CHARS,
  RECAP_SYSTEM_PROMPT,
  __setRecapResumeDelayMsForTesting,
  buildRecapTranscript,
  describeToolCall,
  filterRecapModelCompletions,
  parseRecapData,
  recapEntryRenderer,
  sanitizeRecap,
  shouldAutoRecap,
} from "./recap.ts";

let nextId = 0;
const id = (): string => `e${nextId++}`;

type MessageEntry = Extract<SessionEntry, { type: "message" }>;

function userEntry(text: string): MessageEntry {
  return {
    type: "message",
    id: id(),
    parentId: null,
    timestamp: new Date(1).toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
  };
}

function assistantEntry(
  content: Array<Record<string, unknown>>,
  model = "anthropic/claude-x",
): MessageEntry {
  return {
    type: "message",
    id: id(),
    parentId: null,
    timestamp: new Date(2).toISOString(),
    message: {
      role: "assistant",
      content,
      model,
      api: "anthropic-messages",
      provider: "anthropic",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    } as unknown as MessageEntry["message"],
  };
}

function toolResultEntry(
  toolName: string,
  text: string,
  isError: boolean,
): MessageEntry {
  return {
    type: "message",
    id: id(),
    parentId: null,
    timestamp: new Date(3).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName,
      content: [{ type: "text", text }],
      isError,
      timestamp: 3,
    },
  };
}

function compactionEntry(summary: string): SessionEntry {
  return {
    type: "compaction",
    id: id(),
    parentId: null,
    timestamp: new Date(4).toISOString(),
    summary,
    firstKeptEntryId: "e0",
    tokensBefore: 100,
  };
}

function recapEntry(text = "a recap"): CustomEntry {
  return {
    type: "custom",
    id: id(),
    parentId: null,
    timestamp: new Date(5).toISOString(),
    customType: RECAP_ENTRY_TYPE,
    data: {
      v: 1,
      text,
      model: "anthropic/claude-x",
      createdAt: "",
      trigger: "manual",
    },
  };
}

describe("buildRecapTranscript", () => {
  test("keeps conversation text, tool calls, tool errors; drops thinking and success output", () => {
    const entries: SessionEntry[] = [
      userEntry("fix the login bug"),
      assistantEntry([
        { type: "thinking", thinking: "SECRET REASONING" },
        { type: "text", text: "Looking at the auth module." },
        {
          type: "toolCall",
          id: "t1",
          name: "read",
          arguments: { path: "src/auth.ts" },
        },
      ]),
      toolResultEntry("read", "FILE CONTENTS", false),
      assistantEntry([
        {
          type: "toolCall",
          id: "t2",
          name: "bash",
          arguments: { command: "bun test auth" },
        },
      ]),
      toolResultEntry("bash", "3 tests failed", true),
    ];

    const transcript = buildRecapTranscript(entries);
    expect(transcript).toContain("User: fix the login bug");
    expect(transcript).toContain("Assistant: Looking at the auth module.");
    expect(transcript).toContain("[tool] read: src/auth.ts");
    expect(transcript).toContain("[tool] bash: bun test auth");
    expect(transcript).toContain("[tool error] bash: 3 tests failed");
    expect(transcript).not.toContain("SECRET REASONING");
    expect(transcript).not.toContain("FILE CONTENTS");
  });

  test("keeps only the newest compaction summary", () => {
    const transcript = buildRecapTranscript([
      compactionEntry("OLD SUMMARY"),
      userEntry("newer question"),
      compactionEntry("NEW SUMMARY"),
      userEntry("latest question"),
    ]);
    expect(transcript).toContain("[earlier session summary] NEW SUMMARY");
    expect(transcript).not.toContain("OLD SUMMARY");
  });

  test("includes displayed injections but not hidden ones", () => {
    const displayed: SessionEntry = {
      type: "custom_message",
      id: id(),
      parentId: null,
      timestamp: new Date(6).toISOString(),
      customType: "side-handoff",
      display: true,
      content: "the consultant disagrees",
    };
    const hidden: SessionEntry = {
      ...displayed,
      id: id(),
      customType: "machinery",
      display: false,
      content: "SHOULD NOT APPEAR",
    };
    const transcript = buildRecapTranscript([displayed, hidden]);
    expect(transcript).toContain(
      "[context: side-handoff] the consultant disagrees",
    );
    expect(transcript).not.toContain("SHOULD NOT APPEAR");
  });

  test("keeps the tail under the character budget", () => {
    const entries: SessionEntry[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(userEntry(`message number ${i} ${"x".repeat(40)}`));
    }
    const transcript = buildRecapTranscript(entries, {
      maxChars: 500,
      recentUserTurns: 50,
    });
    // User messages are pinned: the budget never drops them.
    expect(transcript).toContain("message number 0");
    expect(transcript).toContain("message number 49");
  });

  test("windows to the newest user messages, pins the first, drops tool results", () => {
    const entries: SessionEntry[] = [
      userEntry("ORIGINAL GOAL: migrate the auth module"),
      assistantEntry([{ type: "text", text: "OLD ASSISTANT" }]),
      userEntry("OLD FOLLOWUP"),
      assistantEntry([{ type: "text", text: "OLD ASSISTANT 2" }]),
      userEntry("second to last"),
      assistantEntry([
        { type: "text", text: "On it." },
        {
          type: "toolCall",
          id: "a",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ]),
      toolResultEntry("read", "RESULT BODY", false),
      assistantEntry([
        {
          type: "toolCall",
          id: "b",
          name: "bash",
          arguments: { command: "bun test" },
        },
      ]),
      toolResultEntry("bash", "boom", true),
      userEntry("latest: ok go"),
      assistantEntry([{ type: "text", text: "Done." }]),
    ];
    const transcript = buildRecapTranscript(entries);
    const lines = transcript.split("\n");
    expect(lines[0]).toBe(
      "User (session start): ORIGINAL GOAL: migrate the auth module",
    );
    expect(lines[1]).toBe("[earlier turns omitted]");
    expect(lines[2]).toBe("User: second to last");
    expect(transcript).toContain("[tool] read: a.ts");
    expect(transcript).toContain("[tool] bash: bun test");
    expect(transcript).toContain("[tool error] bash: boom");
    expect(transcript).toContain("User: latest: ok go");
    expect(transcript).toContain("Assistant: Done.");
    expect(transcript).not.toContain("OLD FOLLOWUP");
    expect(transcript).not.toContain("OLD ASSISTANT");
    expect(transcript).not.toContain("RESULT BODY");
  });

  test("does not repeat the first message when it is already inside the window", () => {
    const transcript = buildRecapTranscript([
      userEntry("the only goal"),
      assistantEntry([{ type: "text", text: "ok" }]),
      userEntry("tweak it"),
    ]);
    expect(transcript).not.toContain("session start");
    expect(transcript).not.toContain("earlier turns omitted");
    expect(transcript.match(/the only goal/g)).toHaveLength(1);
  });

  test("recentUserTurns widens or narrows the window", () => {
    const entries: SessionEntry[] = [
      userEntry("first"),
      userEntry("second"),
      userEntry("third"),
      userEntry("fourth"),
    ];
    const one = buildRecapTranscript(entries, { recentUserTurns: 1 });
    expect(one).toContain("User (session start): first");
    expect(one).toContain("User: fourth");
    expect(one).not.toContain("second");
    expect(one).not.toContain("third");
    const three = buildRecapTranscript(entries, { recentUserTurns: 3 });
    expect(three).toContain("User (session start): first");
    expect(three).toContain("User: second");
    expect(three).not.toContain("earlier turns omitted"); // nothing in between
    const all = buildRecapTranscript(entries, { recentUserTurns: 4 });
    expect(all).not.toContain("session start");
    expect(all).toContain("User: first");
  });

  test("the budget trims the oldest assistant/tool lines, never user messages", () => {
    const entries: SessionEntry[] = [
      userEntry("start"),
      userEntry("the question"),
    ];
    for (let i = 0; i < 40; i++) {
      entries.push(
        assistantEntry([{ type: "text", text: `step ${i} ${"y".repeat(60)}` }]),
      );
    }
    entries.push(userEntry("the latest ask"));
    entries.push(assistantEntry([{ type: "text", text: "final step" }]));
    const transcript = buildRecapTranscript(entries, { maxChars: 400 });
    expect(transcript).toContain("User: the question");
    expect(transcript).toContain("User: the latest ask");
    expect(transcript).toContain("final step");
    expect(transcript).toContain("[steps omitted]");
    expect(transcript).not.toContain("step 0 ");
  });

  test("a single oversized newest line is still kept", () => {
    const transcript = buildRecapTranscript(
      [
        userEntry("go"),
        assistantEntry([{ type: "text", text: "z".repeat(500) }]),
      ],
      { maxChars: 50 },
    );
    expect(transcript).toContain("zzzz");
  });

  test("returns an empty string for an empty branch", () => {
    expect(buildRecapTranscript([])).toBe("");
  });
});

describe("sanitizeRecap", () => {
  test("strips labels, markdown, quotes, and newlines", () => {
    expect(
      sanitizeRecap('**Recap:** "you fixed the auth bug.\nNext: add tests."'),
    ).toBe("you fixed the auth bug. Next: add tests.");
  });

  test("caps at the 400-character limit at a word boundary", () => {
    const text = `${"word ".repeat(100)}end`;
    const cleaned = sanitizeRecap(text);
    expect(cleaned.length).toBeLessThanOrEqual(RECAP_MAX_CHARS);
    expect(cleaned.endsWith("…")).toBe(true);
    expect(cleaned).not.toContain("wor…");
  });

  test("drops an empty response", () => {
    expect(sanitizeRecap("  \n ")).toBe("");
  });
});

describe("shouldAutoRecap", () => {
  const threeTurns = (): SessionEntry[] => [
    userEntry("one"),
    assistantEntry([{ type: "text", text: "a" }]),
    userEntry("two"),
    assistantEntry([{ type: "text", text: "b" }]),
    userEntry("three"),
    assistantEntry([{ type: "text", text: "c" }]),
  ];

  test("needs at least three user turns", () => {
    expect(shouldAutoRecap([userEntry("one"), userEntry("two")])).toBe(false);
    expect(shouldAutoRecap(threeTurns())).toBe(true);
  });

  test("does not repeat when the recap is the newest content", () => {
    expect(shouldAutoRecap([...threeTurns(), recapEntry()])).toBe(false);
  });

  test("runs again after a new user or assistant message", () => {
    expect(
      shouldAutoRecap([
        ...threeTurns(),
        recapEntry(),
        assistantEntry([{ type: "text", text: "new work" }]),
      ]),
    ).toBe(true);
  });

  test("a tool result alone is not new activity", () => {
    expect(
      shouldAutoRecap([
        ...threeTurns(),
        recapEntry(),
        toolResultEntry("read", "ok", false),
      ]),
    ).toBe(false);
  });
});

describe("recapEntryRenderer", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  function render(text: string, width: number): string[] {
    const component = recapEntryRenderer(
      {
        ...recapEntry(""),
        data: { v: 1, text },
        customType: RECAP_ENTRY_TYPE,
      } as CustomEntry,
      { expanded: false },
      theme as never,
    );
    expect(component).toBeDefined();
    return component!.render(width);
  }

  test("renders a labelled transcript line", () => {
    const lines = render("you fixed the auth bug.", 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("▸ recap you fixed the auth bug.");
  });

  test("wraps with a hanging indent on narrow terminals", () => {
    const lines = render("one two three four five six seven eight", 24);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      expect(line.startsWith("        ")).toBe(true);
    }
  });
});

describe("parseRecapData", () => {
  test("accepts a valid payload", () => {
    const data = parseRecapData({
      v: 1,
      text: "you did things",
      model: "p/m",
      createdAt: "2026-01-01T00:00:00.000Z",
      trigger: "idle",
    });
    expect(data?.text).toBe("you did things");
    expect(data?.trigger).toBe("idle");
  });

  test("rejects junk and empty text", () => {
    expect(parseRecapData(null)).toBeUndefined();
    expect(parseRecapData({ text: "" })).toBeUndefined();
    expect(parseRecapData("nope")).toBeUndefined();
  });
});

describe("describeToolCall", () => {
  test("prefers command/path and never dumps huge payloads", () => {
    expect(describeToolCall("bash", { command: "ls -la" })).toBe(
      "[tool] bash: ls -la",
    );
    expect(
      describeToolCall("write", { path: "a.ts", content: "x".repeat(900) }),
    ).toBe("[tool] write: a.ts");
    expect(describeToolCall("weird", null)).toBe("[tool] weird");
  });
});

// ── Extension behavior with a fake Pi + model registry ─────────────────────

function makeModel(provider: string, modelId: string): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider,
    baseUrl: `https://${provider}.test/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    maxTokens: 100,
  };
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

class PiHarness {
  readonly handlers = new Map<string, Handler>();
  readonly commands = new Map<
    string,
    {
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      getArgumentCompletions?: (prefix: string) => unknown;
    }
  >();
  readonly entries: Array<{ customType: string; data: unknown }> = [];
  readonly api = {
    registerEntryRenderer: () => {},
    registerCommand: (
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
        getArgumentCompletions?: (prefix: string) => unknown;
      },
    ) => {
      this.commands.set(name, options);
    },
    on: (event: string, handler: Handler) => {
      this.handlers.set(event, handler);
      return () => {};
    },
    appendEntry: (customType: string, data: unknown) => {
      this.entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  async emit(event: string, payload: object, ctx: ExtensionContext) {
    const handler = this.handlers.get(event);
    expect(handler).toBeDefined();
    await handler?.(payload, ctx);
  }
}

interface FakeCtx {
  ctx: ExtensionCommandContext;
  notices: Array<{ message: string; type?: string }>;
  completions: Array<{ model: Model<Api>; context: unknown }>;
  wrappers: unknown[];
}

function makeCtx(options: {
  branch?: SessionEntry[];
  reply?: string;
  stopReason?: AssistantMessage["stopReason"];
  errorMessage?: string;
  models?: Model<Api>[];
  activeModel?: Model<Api>;
  complete?: () => Promise<never>;
}): FakeCtx {
  const notices: Array<{ message: string; type?: string }> = [];
  const completions: Array<{ model: Model<Api>; context: unknown }> = [];
  const wrappers: unknown[] = [];
  const models = options.models ?? [makeModel("anthropic", "claude-x")];
  const branch = options.branch ?? [
    userEntry("one"),
    assistantEntry([{ type: "text", text: "a" }]),
    userEntry("two"),
    assistantEntry([{ type: "text", text: "b" }]),
    userEntry("three"),
    assistantEntry([{ type: "text", text: "c" }]),
  ];

  const registry = {
    find: (provider: string, modelId: string) =>
      models.find((m) => m.provider === provider && m.id === modelId),
    getAvailable: () => models,
    complete: async (model: Model<Api>, context: unknown) => {
      completions.push({ model, context });
      if (options.complete) return options.complete();
      return {
        role: "assistant",
        content: [
          {
            type: "text",
            text: options.reply ?? "**Recap:** you are testing the recap.",
          },
        ],
        stopReason: options.stopReason ?? "stop",
        errorMessage: options.errorMessage,
        model: model.id,
        provider: model.provider,
        api: model.api,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      } as unknown as AssistantMessage;
    },
  };

  const ctx = {
    mode: "tui",
    cwd: "/project",
    model: options.activeModel ?? models[0],
    modelRegistry: registry,
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "session-1",
      getSessionName: () => "test session",
      getEntries: () => branch,
    },
    isIdle: () => true,
    waitForIdle: async () => {},
    ui: {
      notify: (message: string, type?: string) => {
        notices.push({ message, type });
      },
      setStatus: () => {},
      addAutocompleteProvider: (wrapper: unknown) => {
        wrappers.push(wrapper);
      },
    },
  } as unknown as ExtensionCommandContext;

  return { ctx, notices, completions, wrappers };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "recap-log-"));
  setGoodiesLogPathForTesting(join(dir, "goodies.log"));
  const configPath = join(dir, "goodies.json");
  writeFileSync(configPath, "{}");
  __setConfigPathForTesting(configPath);
  __setRecapResumeDelayMsForTesting(5);
});

afterEach(() => {
  __setRecapResumeDelayMsForTesting(1200);
  setGoodiesLogPathForTesting(undefined);
});

describe("/recap", () => {
  test("generates a sanitized line and appends a non-context custom entry", async () => {
    const pi = new PiHarness();
    recapExtension(pi.api);
    const { ctx, completions } = makeCtx({});

    await pi.commands.get("recap")?.handler("", ctx);

    expect(pi.entries).toHaveLength(1);
    expect(pi.entries[0]?.customType).toBe(RECAP_ENTRY_TYPE);
    const data = parseRecapData(pi.entries[0]?.data);
    expect(data?.text).toBe("you are testing the recap.");
    expect(data?.model).toBe("anthropic/claude-x");
    expect(data?.trigger).toBe("manual");
    expect(completions[0]?.model.id).toBe("claude-x");
    const context = completions[0]?.context as {
      systemPrompt?: string;
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(context.systemPrompt).toBe(RECAP_SYSTEM_PROMPT);
    expect(context.messages[0]?.content[0]?.text).toContain("User: three");
  });

  test("accepts an explicit provider/model override", async () => {
    const pi = new PiHarness();
    recapExtension(pi.api);
    const other = makeModel("kilo", "glm-5");
    const { ctx, completions } = makeCtx({ models: [other] });

    await pi.commands.get("recap")?.handler("kilo/glm-5", ctx);

    expect(completions[0]?.model).toBe(other);
    expect(parseRecapData(pi.entries[0]?.data)?.model).toBe("kilo/glm-5");
  });

  test("reports an unknown model without calling it", async () => {
    const pi = new PiHarness();
    recapExtension(pi.api);
    const { ctx, notices, completions } = makeCtx({});

    await pi.commands.get("recap")?.handler("nope/missing", ctx);

    expect(completions).toHaveLength(0);
    expect(pi.entries).toHaveLength(0);
    expect(notices[0]?.type).toBe("error");
    expect(notices[0]?.message).toContain('unknown model "nope/missing"');
  });

  test("surfaces provider errors", async () => {
    const pi = new PiHarness();
    recapExtension(pi.api);
    const { ctx, notices } = makeCtx({
      stopReason: "error",
      errorMessage: "quota exhausted",
    });

    await pi.commands.get("recap")?.handler("", ctx);

    expect(pi.entries).toHaveLength(0);
    expect(notices[0]?.message).toContain("quota exhausted");
  });

  test("returns model completions as provider/id", () => {
    const { ctx } = makeCtx({
      models: [makeModel("anthropic", "claude-x"), makeModel("kilo", "glm-5")],
    });
    expect(filterRecapModelCompletions("kilo/", ctx.modelRegistry)).toEqual([
      { value: "kilo/glm-5", label: "kilo/glm-5" },
    ]);
    expect(filterRecapModelCompletions("zzz", ctx.modelRegistry)).toBeNull();
  });

  test("completions match anywhere in provider/id, prefix hits first", () => {
    const { ctx } = makeCtx({
      models: [
        makeModel("kilo", "glm-5"),
        makeModel("zai", "glm-5.3-flash"),
        makeModel("glm", "x"),
      ],
    });
    expect(
      filterRecapModelCompletions("glm", ctx.modelRegistry)?.map(
        (c) => c.value,
      ),
    ).toEqual(["glm/x", "kilo/glm-5", "zai/glm-5.3-flash"]);
    expect(filterRecapModelCompletions("", ctx.modelRegistry)?.length).toBe(3);
  });

  test("installs the forced-Tab wrapper once so Tab never lists cwd paths", async () => {
    const pi = new PiHarness();
    recapExtension(pi.api);
    const { ctx, wrappers } = makeCtx({});
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit("session_start", { reason: "new" }, ctx);
    expect(wrappers).toHaveLength(1);
  });

  test("uses the configured recap-model; an explicit argument still wins", async () => {
    const glm = makeModel("kilo", "glm-5");
    const claude = makeModel("anthropic", "claude-x");
    setRecapModel("kilo/glm-5");
    const pi = new PiHarness();
    recapExtension(pi.api);
    const { ctx, completions } = makeCtx({
      models: [claude, glm],
      activeModel: claude,
    });

    await pi.commands.get("recap")?.handler("", ctx);
    expect(completions[0]?.model).toBe(glm);
    expect(parseRecapData(pi.entries[0]?.data)?.model).toBe("kilo/glm-5");

    await pi.commands.get("recap")?.handler("anthropic/claude-x", ctx);
    expect(completions[1]?.model).toBe(claude);
  });

  test("a configured recap-model that vanished is reported, not silently swapped", async () => {
    setRecapModel("kilo/gone");
    const pi = new PiHarness();
    recapExtension(pi.api);
    const { ctx, notices, completions } = makeCtx({});
    await pi.commands.get("recap")?.handler("", ctx);
    expect(completions).toHaveLength(0);
    expect(notices[0]?.type).toBe("error");
    expect(notices[0]?.message).toContain("kilo/gone");
    expect(notices[0]?.message).toContain("/goodies recap-model");
  });

  test("recap-turns controls how much history the model sees", async () => {
    setRecapTurns(1);
    const pi = new PiHarness();
    recapExtension(pi.api);
    const { ctx, completions } = makeCtx({});
    await pi.commands.get("recap")?.handler("", ctx);
    const text = (
      completions[0]?.context as {
        messages: Array<{ content: Array<{ text: string }> }>;
      }
    ).messages[0]?.content[0]?.text;
    expect(text).toContain("User (session start): one");
    expect(text).toContain("User: three");
    expect(text).not.toContain("two");
  });
});

describe("automatic recap after idle", () => {
  test("fires once the idle window passes with new activity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recap-idle-"));
    const configPath = join(dir, "goodies.json");
    // 0.001 minutes = 60ms; the extension reads minutes from goodies.json.
    writeFileSync(configPath, JSON.stringify({ "recap-idle-minutes": 0.001 }));
    __setConfigPathForTesting(configPath);

    const pi = new PiHarness();
    recapExtension(pi.api);
    const { ctx, completions } = makeCtx({});

    await pi.emit(
      "message_end",
      { type: "message_end", message: { role: "user" } },
      ctx,
    );
    expect(completions).toHaveLength(0); // not synchronously
    await sleep(140);

    expect(completions).toHaveLength(1);
    expect(parseRecapData(pi.entries[0]?.data)?.trigger).toBe("idle");
  });
});

describe("automatic recap on resume", () => {
  test("runs shortly after a resume and appends a resume-triggered entry", async () => {
    const pi = new PiHarness();
    recapExtension(pi.api);
    const { ctx, completions } = makeCtx({});

    await pi.emit(
      "session_start",
      { type: "session_start", reason: "resume" },
      ctx,
    );
    await sleep(30);

    expect(completions).toHaveLength(1);
    expect(parseRecapData(pi.entries[0]?.data)?.trigger).toBe("resume");
  });

  test("does not run twice when the session already ends in a recap", async () => {
    const pi = new PiHarness();
    recapExtension(pi.api);
    const branch = [
      userEntry("one"),
      assistantEntry([{ type: "text", text: "a" }]),
      userEntry("two"),
      assistantEntry([{ type: "text", text: "b" }]),
      userEntry("three"),
      assistantEntry([{ type: "text", text: "c" }]),
      recapEntry(),
    ];
    const { ctx, completions } = makeCtx({ branch });

    await pi.emit(
      "session_start",
      { type: "session_start", reason: "resume" },
      ctx,
    );
    await sleep(30);

    expect(completions).toHaveLength(0);
    expect(pi.entries).toHaveLength(0);
  });

  test("never rejects the background path when the provider fails", async () => {
    const pi = new PiHarness();
    recapExtension(pi.api);
    const { ctx, notices } = makeCtx({
      complete: async () => {
        throw new Error("network down");
      },
    });

    await pi.emit(
      "session_start",
      { type: "session_start", reason: "resume" },
      ctx,
    );
    await sleep(30);

    expect(notices).toHaveLength(0); // auto failures are log-only
    expect(pi.entries).toHaveLength(0);
  });

  test("does not run for a plain startup", async () => {
    const pi = new PiHarness();
    recapExtension(pi.api);
    const { ctx, completions } = makeCtx({});

    await pi.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      ctx,
    );
    await sleep(30);

    expect(completions).toHaveLength(0);
  });
});
