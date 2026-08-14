import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULTS,
  loadConfig,
  mapProviderFromSession,
  MAX_INPUT_CHARS,
  type ClConfig,
} from "./config.ts";
import {
  buildPrompt,
  rewrite,
  stubRewrite,
  type FetchLike,
} from "./providers.ts";
import {
  extractText,
  isInside,
  isMarkdownPath,
  proseLength,
  splitFrontmatter,
} from "./text.ts";

// ── config.ts ──────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claudish-cfg-"));
  });
  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function configPath(name: string): string {
    return join(tempDir, name);
  }

  test("absent file returns all defaults", () => {
    const {
      config: c,
      present,
      error,
    } = loadConfig(configPath("missing.json"));
    expect(present).toBe(false);
    expect(error).toBeNull();
    expect(c).toEqual(DEFAULTS);
  });

  test("empty object returns all defaults", () => {
    const path = configPath("empty.json");
    writeFileSync(path, "{}");
    const { config: c, present, error } = loadConfig(path);
    expect(present).toBe(true);
    expect(error).toBeNull();
    expect(c.enabled).toBe(true);
    expect(c.provider).toBeUndefined();
    expect(c.model).toBeUndefined();
    expect(c.ollamaUrl).toBe("http://localhost:11434");
    expect(c.anthropicUrl).toBe("https://api.anthropic.com");
    expect(c.openaiUrl).toBe("https://api.openai.com/v1");
    expect(c.openaiEffort).toBeUndefined();
    expect(c.maxTokens).toBe(4096);
    expect(c.minChars).toBe(200);
    expect(c.stub).toBe(false);
    expect(c.displayTimeoutMs).toBe(45_000);
    expect(c.mdTimeoutMs).toBe(150_000);
    expect(c.debug).toBe(false);
    expect(c.notice).toBe(true);
    expect(c.mdDir).toBeUndefined();
    expect(c.mdMode).toBe("sibling");
    expect(c.mdSuffix).toBe("plain");
  });

  test("invalid provider is treated as undefined", () => {
    const path = configPath("bad-provider.json");
    writeFileSync(path, JSON.stringify({ provider: "gpt4all" }));
    const { config: c } = loadConfig(path);
    expect(c.provider).toBeUndefined();
  });

  test("valid provider is parsed", () => {
    const path = configPath("anthropic.json");
    writeFileSync(path, JSON.stringify({ provider: "anthropic" }));
    const { config: c } = loadConfig(path);
    expect(c.provider).toBe("anthropic");
  });

  test("model is parsed when non-empty, undefined when blank", () => {
    const path = configPath("model.json");
    writeFileSync(path, JSON.stringify({ model: "llama3.2:3b" }));
    const { config: c } = loadConfig(path);
    expect(c.model).toBe("llama3.2:3b");

    const pathBlank = configPath("model-blank.json");
    writeFileSync(pathBlank, JSON.stringify({ model: "  " }));
    const { config: c2 } = loadConfig(pathBlank);
    expect(c2.model).toBeUndefined();
  });

  test("openaiEffort: empty string omits, value is kept", () => {
    const pathEmpty = configPath("effort-empty.json");
    writeFileSync(pathEmpty, JSON.stringify({ openaiEffort: "" }));
    const { config: c1 } = loadConfig(pathEmpty);
    expect(c1.openaiEffort).toBeUndefined();

    const pathSet = configPath("effort-low.json");
    writeFileSync(pathSet, JSON.stringify({ openaiEffort: "low" }));
    const { config: c2 } = loadConfig(pathSet);
    expect(c2.openaiEffort).toBe("low");
  });

  test("trailing slashes are stripped from URLs", () => {
    const path = configPath("urls.json");
    writeFileSync(
      path,
      JSON.stringify({
        ollamaUrl: "http://localhost:11434///",
        anthropicUrl: "https://gateway.example.com/",
        openaiUrl: "https://proxy.example.com/v1//",
      }),
    );
    const { config: c } = loadConfig(path);
    expect(c.ollamaUrl).toBe("http://localhost:11434");
    expect(c.anthropicUrl).toBe("https://gateway.example.com");
    expect(c.openaiUrl).toBe("https://proxy.example.com/v1");
  });

  test("invalid numeric values fall back, valid ones are kept", () => {
    const path = configPath("nums.json");
    writeFileSync(
      path,
      JSON.stringify({
        maxTokens: "abc",
        minChars: -3,
        displayTimeoutMs: 0,
        mdTimeoutMs: 999999,
      }),
    );
    const { config: c } = loadConfig(path);
    expect(c.maxTokens).toBe(4096);
    expect(c.minChars).toBe(200);
    expect(c.displayTimeoutMs).toBe(45_000);
    expect(c.mdTimeoutMs).toBe(150_000);

    const pathGood = configPath("nums-good.json");
    writeFileSync(
      pathGood,
      JSON.stringify({
        maxTokens: 8192,
        minChars: 50,
        displayTimeoutMs: 10_000,
        mdTimeoutMs: 60_000,
      }),
    );
    const { config: c2 } = loadConfig(pathGood);
    expect(c2.maxTokens).toBe(8192);
    expect(c2.minChars).toBe(50);
    expect(c2.displayTimeoutMs).toBe(10_000);
    expect(c2.mdTimeoutMs).toBe(60_000);
  });

  test("boolean switches parse correctly", () => {
    const path = configPath("switches.json");
    writeFileSync(
      path,
      JSON.stringify({
        enabled: false,
        stub: true,
        debug: true,
        notice: false,
      }),
    );
    const { config: c } = loadConfig(path);
    expect(c.enabled).toBe(false);
    expect(c.stub).toBe(true);
    expect(c.debug).toBe(true);
    expect(c.notice).toBe(false);
  });

  test("md dir is expanded and optional", () => {
    const path = configPath("md.json");
    writeFileSync(
      path,
      JSON.stringify({
        mdDir: "~/docs/plain",
        mdMode: "overwrite",
      }),
    );
    const { config: c } = loadConfig(path);
    expect(c.mdDir).toBe(join(process.env.HOME ?? "", "docs", "plain"));
    expect(c.mdMode).toBe("overwrite");

    const pathEmpty = configPath("md-empty.json");
    writeFileSync(pathEmpty, JSON.stringify({ mdDir: "  " }));
    const { config: c2 } = loadConfig(pathEmpty);
    expect(c2.mdDir).toBeUndefined();
  });

  test("invalid JSON returns defaults with an error", () => {
    const path = configPath("broken.json");
    writeFileSync(path, "{not valid json");
    const { config: c, error, present } = loadConfig(path);
    expect(present).toBe(true);
    expect(error).not.toBeNull();
    expect(c).toEqual(DEFAULTS);
  });

  test("non-object top level returns defaults with an error", () => {
    const path = configPath("array.json");
    writeFileSync(path, "[]");
    const { config: c, error, present } = loadConfig(path);
    expect(present).toBe(true);
    expect(error).not.toBeNull();
    expect(c).toEqual(DEFAULTS);
  });
});

describe("mapProviderFromSession", () => {
  test("maps known providers", () => {
    expect(mapProviderFromSession("anthropic")).toBe("anthropic");
    expect(mapProviderFromSession("openai")).toBe("openai");
  });

  test("returns undefined for unknown or missing providers", () => {
    expect(mapProviderFromSession("kilo")).toBeUndefined();
    expect(mapProviderFromSession(undefined)).toBeUndefined();
    expect(mapProviderFromSession("")).toBeUndefined();
  });
});

// ── text.ts ────────────────────────────────────────────────────────────────

describe("text helpers", () => {
  test("extractText handles strings and block arrays", () => {
    expect(extractText("plain")).toBe("plain");
    expect(
      extractText([
        { type: "text", text: "hello" },
        { type: "toolCall", name: "bash", arguments: {} },
        { type: "text", text: " world" },
      ]),
    ).toBe("hello\n world");
    expect(
      extractText([{ type: "toolCall", name: "bash", arguments: {} }]),
    ).toBe("");
    expect(extractText(null)).toBe("");
  });

  test("proseLength strips fenced and inline code", () => {
    const md = "Some prose\n```ts\nconst x = 1;\n```\nand `inline` code";
    const len = proseLength(md);
    expect(len).toBeGreaterThan(0);
    expect(len).toBeLessThan(md.length);
  });

  test("splitFrontmatter re-attaches verbatim and handles missing frontmatter", () => {
    const withFm = "---\ntitle: Hi\n---\n# Body\ncontent";
    const { frontmatter, body } = splitFrontmatter(withFm);
    expect(frontmatter).toBe("---\ntitle: Hi\n---\n");
    expect(body).toBe("# Body\ncontent");
    expect(frontmatter + body).toBe(withFm);

    const noFm = splitFrontmatter("# Just body");
    expect(noFm.frontmatter).toBe("");
    expect(noFm.body).toBe("# Just body");
  });

  test("isInside only accepts paths at or under the directory", () => {
    const dir = "/work/docs";
    expect(isInside(dir, "/work/docs/a.md")).toBe(true);
    expect(isInside(dir, "/work/docs/sub/a.md")).toBe(true);
    expect(isInside(dir, "/work/docs")).toBe(false); // the dir itself
    expect(isInside(dir, "/work/docs2/a.md")).toBe(false); // prefix trap
    expect(isInside(dir, "/etc/a.md")).toBe(false);
    // Paths are normalized before containment is checked.
    expect(isInside(dir, "/work/docs2/../docs/a.md")).toBe(true);
  });

  test("isMarkdownPath accepts case-insensitive .md", () => {
    expect(isMarkdownPath("/a/b.md")).toBe(true);
    expect(isMarkdownPath("/a/b.MD")).toBe(true);
    expect(isMarkdownPath("/a/b.md.txt")).toBe(false);
  });
});

// ── providers.ts ───────────────────────────────────────────────────────────

describe("providers", () => {
  function configFor(overrides: Partial<ClConfig> = {}): ClConfig {
    return { ...DEFAULTS, ...overrides };
  }

  /** A fake fetch that returns a canned JSON response. */
  function jsonFetch(status: number, body: unknown, fail?: boolean): FetchLike {
    return (async () => {
      if (fail) throw new Error("network down");
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    }) as FetchLike;
  }

  test("buildPrompt embeds question and message, truncates huge input", () => {
    const p = buildPrompt("the message", "the question");
    expect(p).toContain("the question");
    expect(p).toContain("the message");
    expect(p).toContain("never answer or repeat it");

    const big = buildPrompt("x".repeat(MAX_INPUT_CHARS + 1000));
    expect(big).toContain("[truncated]");
  });

  test("stubRewrite is deterministic", () => {
    expect(stubRewrite("Some message here")).toBe(
      "[claudish stub] Some message here",
    );
    expect(stubRewrite("Some message here")).toBe(
      stubRewrite("Some message here"),
    );
  });

  test("stub mode returns ok without any fetch", async () => {
    const out = await rewrite({
      config: configFor({ stub: true }),
      text: "hi there",
      timeoutMs: 1000,
      provider: "ollama",
      model: "x",
      fetchImpl: (() => {
        throw new Error("should not be called");
      }) as FetchLike,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toBe("[claudish stub] hi there");
  });

  test("ollama: ok response returns text", async () => {
    const out = await rewrite({
      config: configFor(),
      text: "msg",
      timeoutMs: 1000,
      provider: "ollama",
      model: "x",
      fetchImpl: jsonFetch(200, {
        response: "plain version",
        done_reason: "stop",
      }),
    });
    expect(out).toEqual({ ok: true, text: "plain version" });
  });

  test("ollama: num_predict tracks maxTokens", async () => {
    let captured: { body: any } | undefined;
    const fetchImpl = (async (_url: any, init: any) => {
      captured = { body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: "plain", done_reason: "stop" }),
      } as Response;
    }) as FetchLike;
    await rewrite({
      config: configFor({ maxTokens: 8192 }),
      text: "msg",
      timeoutMs: 1000,
      provider: "ollama",
      model: "x",
      fetchImpl,
    });
    expect(captured?.body.options.num_predict).toBe(8192);
  });

  test("ollama: output cap (done_reason length) discards the rewrite", async () => {
    const out = await rewrite({
      config: configFor(),
      text: "msg",
      timeoutMs: 1000,
      provider: "ollama",
      model: "x",
      fetchImpl: jsonFetch(200, { response: "half", done_reason: "length" }),
    });
    expect(out.ok).toBe(false);
  });

  test("anthropic: builds messages request with key and max_tokens", async () => {
    let captured:
      { url: string; headers: Record<string, string>; body: any } | undefined;
    const fetchImpl = (async (url: any, init: any) => {
      captured = {
        url: String(url),
        headers: init.headers,
        body: JSON.parse(init.body),
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "plain" }],
          stop_reason: "end_turn",
        }),
      } as Response;
    }) as FetchLike;

    const out = await rewrite({
      config: configFor({ anthropicUrl: "https://api.anthropic.com" }),
      text: "msg",
      timeoutMs: 1000,
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      apiKey: "sk-ant-test",
      fetchImpl,
    });
    expect(out.ok).toBe(true);
    expect(captured?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured?.headers["x-api-key"]).toBe("sk-ant-test");
    expect(captured?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured?.body.max_tokens).toBe(4096);
    expect(captured?.body.model).toBe("claude-3-5-haiku-latest");
  });

  test("anthropic: missing key fails open", async () => {
    const out = await rewrite({
      config: configFor(),
      text: "msg",
      timeoutMs: 1000,
      provider: "anthropic",
      model: "x",
      apiKey: undefined,
      fetchImpl: jsonFetch(200, {}),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("no API key");
  });

  test("anthropic: max_tokens stop reason discards the rewrite", async () => {
    const out = await rewrite({
      config: configFor(),
      text: "msg",
      timeoutMs: 1000,
      provider: "anthropic",
      model: "x",
      apiKey: "k",
      fetchImpl: jsonFetch(200, {
        content: [{ type: "text", text: "half" }],
        stop_reason: "max_tokens",
      }),
    });
    expect(out.ok).toBe(false);
  });

  test("openai: omits reasoning_effort by default and sends max_tokens", async () => {
    let captured: { url: string; body: any } | undefined;
    const fetchImpl = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "plain" }, finish_reason: "stop" }],
        }),
      } as Response;
    }) as FetchLike;

    const out = await rewrite({
      config: configFor(),
      text: "msg",
      timeoutMs: 1000,
      provider: "openai",
      model: "x",
      apiKey: "sk-x",
      fetchImpl,
    });
    expect(out.ok).toBe(true);
    expect(captured?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(captured?.body.reasoning_effort).toBeUndefined();
    expect(captured?.body.max_tokens).toBe(4096);
  });

  test("openai: local server gets no reasoning_effort and no key required", async () => {
    let captured: { body: any } | undefined;
    const fetchImpl = (async (_url: any, init: any) => {
      captured = { body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "plain" } }] }),
      } as Response;
    }) as FetchLike;

    const out = await rewrite({
      config: configFor({ openaiUrl: "http://localhost:1234/v1" }),
      text: "msg",
      timeoutMs: 1000,
      provider: "openai",
      model: "x",
      apiKey: undefined,
      fetchImpl,
    });
    expect(out.ok).toBe(true);
    expect(captured?.body.reasoning_effort).toBeUndefined();
  });

  test("openai: finish_reason length discards the rewrite", async () => {
    const out = await rewrite({
      config: configFor(),
      text: "msg",
      timeoutMs: 1000,
      provider: "openai",
      model: "x",
      apiKey: "k",
      fetchImpl: jsonFetch(200, {
        choices: [{ message: { content: "half" }, finish_reason: "length" }],
      }),
    });
    expect(out.ok).toBe(false);
  });

  test("non-ok response fails open", async () => {
    const out = await rewrite({
      config: configFor(),
      text: "msg",
      timeoutMs: 1000,
      provider: "ollama",
      model: "x",
      fetchImpl: jsonFetch(500, {}),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("500");
  });

  test("network failure fails open", async () => {
    const out = await rewrite({
      config: configFor(),
      text: "msg",
      timeoutMs: 1000,
      provider: "ollama",
      model: "x",
      fetchImpl: jsonFetch(200, {}, true),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("network down");
  });

  test("timeout fails open", async () => {
    // A fetch that never settles on its own must reject when the abort signal fires.
    const hanging = ((_url: any, init: any) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("timeout")),
        );
      })) as FetchLike;
    const out = await rewrite({
      config: configFor(),
      text: "msg",
      timeoutMs: 50,
      provider: "ollama",
      model: "x",
      fetchImpl: hanging,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("timeout");
  });

  test("missing model fails open without calling fetch", async () => {
    let called = false;
    const out = await rewrite({
      config: configFor(),
      text: "msg",
      timeoutMs: 1000,
      provider: "ollama",
      model: "",
      fetchImpl: (() => {
        called = true;
        return Promise.resolve({} as Response);
      }) as FetchLike,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("no model resolved");
    expect(called).toBe(false);
  });
});

// ── index.ts extension wiring ──────────────────────────────────────────────

describe("extension", () => {
  let tempDir: string;
  let configDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claudish-test-"));
    configDir = mkdtempSync(join(tmpdir(), "claudish-cfg-test-"));
  });
  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  function writeConfig(overrides: Record<string, unknown>): string {
    const offFile = join(tempDir, `off-${Math.random().toString(36).slice(2)}`);
    const path = join(
      configDir,
      `cfg-${Math.random().toString(36).slice(2)}.json`,
    );
    writeFileSync(path, JSON.stringify({ ...overrides, offFile }));
    return path;
  }

  function makeHarness(configOverrides: Record<string, unknown> = {}) {
    const cfgPath = writeConfig(configOverrides);
    const { config: cfg } = loadConfig(cfgPath);

    const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
    const appended: Array<{ customType: string; data: unknown }> = [];
    const notifications: Array<{ message: string; level?: string }> = [];
    const sessionEntries: any[] = [];

    let sessionModel: any = undefined;
    let apiKeyForProvider: (
      provider: string,
    ) => Promise<string | undefined> = async () => undefined;

    const fakePi = {
      on: (event: string, handler: (event: any, ctx: any) => unknown) => {
        handlers[event] = handler;
      },
      appendEntry: (customType: string, data?: unknown) => {
        appended.push({ customType, data });
      },
      registerEntryRenderer: () => {},
      registerCommand: () => {},
    };
    const fakeCtx = {
      cwd: tempDir,
      sessionManager: { getEntries: () => sessionEntries },
      ui: {
        notify: (message: string, level?: string) =>
          notifications.push({ message, level }),
      },
      get model() {
        return sessionModel;
      },
      modelRegistry: {
        getApiKeyForProvider: (provider: string) => apiKeyForProvider(provider),
      },
    };

    return {
      fakePi,
      fakeCtx,
      handlers,
      appended,
      notifications,
      sessionEntries,
      cfg,
      cfgPath,
      setSessionModel: (m: any) => {
        sessionModel = m;
      },
      setApiKeyResolver: (
        fn: (provider: string) => Promise<string | undefined>,
      ) => {
        apiKeyForProvider = fn;
      },
      start: async () => {
        await handlers["session_start"]!(
          { type: "session_start", reason: "startup" },
          fakeCtx,
        );
      },
      tick: () => new Promise((r) => setTimeout(r, 20)),
    };
  }

  async function registerFactory(fakePi: unknown, cfgPath: string) {
    const { default: factory } = await import("./index.ts");
    factory(fakePi as never, { configPath: cfgPath });
  }

  function assistantMessage(text: string, extra?: Record<string, unknown>) {
    return {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        ...extra,
      },
    };
  }

  function writeToolResult(relPath: string) {
    return {
      type: "tool_result",
      toolName: "write",
      toolCallId: "tc1",
      input: { path: relPath, content: "" },
      content: [],
      isError: false,
    };
  }

  // ── Display hook tests ──

  test("display hook appends a rewrite entry for assistant text (stub)", async () => {
    const h = makeHarness({ stub: true, minChars: 1 });
    await registerFactory(h.fakePi, h.cfgPath);
    await h.start();
    await h.handlers["message_end"]!(
      assistantMessage("The system is down."),
      h.fakeCtx,
    );
    await h.tick();
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.customType).toBe("claudish-rewrite");
    const data = h.appended[0]!.data as { text: string };
    expect(data.text).toBe("[claudish stub] The system is down.");
  });

  test("display hook skips user messages and tool-calling-only messages", async () => {
    const h = makeHarness({ stub: true, minChars: 1 });
    await registerFactory(h.fakePi, h.cfgPath);
    await h.start();
    await h.handlers["message_end"]!(
      { type: "message_end", message: { role: "user", content: "hi" } },
      h.fakeCtx,
    );
    await h.handlers["message_end"]!(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: {} }],
        },
      },
      h.fakeCtx,
    );
    await h.handlers["message_end"]!(
      assistantMessage("Short msg", { errorMessage: "boom" }),
      h.fakeCtx,
    );
    await h.tick();
    expect(h.appended).toHaveLength(0);
  });

  test("display hook skips messages below min chars", async () => {
    const h = makeHarness({ stub: true, minChars: 200 });
    await registerFactory(h.fakePi, h.cfgPath);
    await h.start();
    await h.handlers["message_end"]!(assistantMessage("tiny"), h.fakeCtx);
    await h.tick();
    expect(h.appended).toHaveLength(0);
  });

  test("kill switch pauses rewrites mid-session", async () => {
    const h = makeHarness({ stub: true, minChars: 1 });
    await registerFactory(h.fakePi, h.cfgPath);
    await h.start();
    writeFileSync(h.cfg.offFile, "");
    await h.handlers["message_end"]!(
      assistantMessage("Something long enough."),
      h.fakeCtx,
    );
    await h.tick();
    expect(h.appended).toHaveLength(0);
    rmSync(h.cfg.offFile, { force: true });
  });

  test("enabled=false disables the display hook", async () => {
    const h = makeHarness({ stub: true, minChars: 1, enabled: false });
    await registerFactory(h.fakePi, h.cfgPath);
    await h.start();
    await h.handlers["message_end"]!(
      assistantMessage("Something long enough."),
      h.fakeCtx,
    );
    await h.tick();
    expect(h.appended).toHaveLength(0);
  });

  test("notice fires once per session even across repeated failures", async () => {
    // No stub, no model → rewrite fails open, notice fires once.
    const h = makeHarness({ minChars: 1, notice: true });
    await registerFactory(h.fakePi, h.cfgPath);
    await h.start();
    await h.handlers["message_end"]!(
      assistantMessage("First failure."),
      h.fakeCtx,
    );
    await h.handlers["message_end"]!(
      assistantMessage("Second failure."),
      h.fakeCtx,
    );
    await h.tick();
    expect(h.notifications.length).toBe(1);
    expect(h.notifications[0]!.message).toContain("claudish:");
  });

  test("display hook resolves model and provider from ctx.model", async () => {
    // No model in config; ctx.model provides it. Stub mode bypasses the
    // actual fetch, but resolveRuntime still runs and must not throw.
    const h = makeHarness({ stub: true, minChars: 1 });
    h.setSessionModel({ provider: "anthropic", id: "claude-3-5-haiku-latest" });
    h.setApiKeyResolver(async (p) =>
      p === "anthropic" ? "sk-test-from-pi" : undefined,
    );
    await registerFactory(h.fakePi, h.cfgPath);
    await h.start();
    await h.handlers["message_end"]!(
      assistantMessage("Resolved from session."),
      h.fakeCtx,
    );
    await h.tick();
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.customType).toBe("claudish-rewrite");
  });

  // ── Markdown hook tests ──

  test("md hook writes a sibling file for markdown written under mdDir", async () => {
    const mdDir = join(tempDir, "docs");
    mkdirSync(mdDir, { recursive: true });
    const src = join(mdDir, "plan.md");
    writeFileSync(
      src,
      "---\ntitle: Plan\n---\n# The plan\nDetailed prose body for rewriting.",
    );

    const h = makeHarness({ stub: true, minChars: 1, mdDir });
    await registerFactory(h.fakePi, h.cfgPath);
    await h.start();
    await h.handlers["tool_result"]!(
      writeToolResult("docs/plan.md"),
      h.fakeCtx,
    );
    await h.tick();

    const sibling = join(mdDir, "plan.plain.md");
    expect(existsSync(sibling)).toBe(true);
    const out = readFileSync(sibling, "utf8");
    expect(out).toContain("---\ntitle: Plan\n---\n"); // frontmatter verbatim
    expect(out).toContain("[claudish stub]");
    expect(readFileSync(src, "utf8")).not.toContain("[claudish stub]");
  });

  test("md hook overwrites in place with an idempotent marker", async () => {
    const mdDir = join(tempDir, "docs2");
    mkdirSync(mdDir, { recursive: true });
    const src = join(mdDir, "spec.md");
    const body =
      "# Spec\nA very long and detailed body that qualifies for a rewrite.";
    writeFileSync(src, body);

    const h = makeHarness({
      stub: true,
      minChars: 1,
      mdDir,
      mdMode: "overwrite",
    });
    await registerFactory(h.fakePi, h.cfgPath);
    await h.start();
    await h.handlers["tool_result"]!(
      writeToolResult("docs2/spec.md"),
      h.fakeCtx,
    );
    await h.tick();

    const once = readFileSync(src, "utf8");
    expect(once).toContain("<!-- claudish-to-english:rewritten -->");
    expect(once).toContain("[claudish stub]");

    // Second write of the same file is skipped (idempotent).
    const before = readFileSync(src, "utf8");
    await h.handlers["tool_result"]!(
      writeToolResult("docs2/spec.md"),
      h.fakeCtx,
    );
    await h.tick();
    expect(readFileSync(src, "utf8")).toBe(before);
  });

  test("md hook ignores non-md files and files outside mdDir", async () => {
    const mdDir = join(tempDir, "docs3");
    mkdirSync(mdDir, { recursive: true });
    const inside = join(mdDir, "a.md");
    writeFileSync(inside, "A sufficiently long body inside the directory.");
    const outside = join(tempDir, "outside.md");
    writeFileSync(outside, "A sufficiently long body outside the directory.");
    const notMd = join(mdDir, "b.txt");
    writeFileSync(notMd, "A sufficiently long body that is not markdown.");

    const h = makeHarness({ stub: true, minChars: 1, mdDir });
    await registerFactory(h.fakePi, h.cfgPath);
    await h.start();
    await h.handlers["tool_result"]!(writeToolResult("outside.md"), h.fakeCtx);
    await h.handlers["tool_result"]!(writeToolResult("docs3/b.txt"), h.fakeCtx);
    await h.handlers["tool_result"]!(writeToolResult("docs3/a.md"), h.fakeCtx);
    await h.tick();

    expect(existsSync(join(tempDir, "outside.plain.md"))).toBe(false);
    expect(existsSync(join(mdDir, "b.plain.txt"))).toBe(false);
    expect(existsSync(join(mdDir, "a.plain.md"))).toBe(true);
  });

  test("md hook resolves a relative mdDir against ctx.cwd", async () => {
    const relDir = "rel-docs";
    const mdDir = join(tempDir, relDir);
    mkdirSync(mdDir, { recursive: true });
    const src = join(mdDir, "note.md");
    writeFileSync(src, "A long enough body to qualify for a rewrite.");

    const h = makeHarness({ stub: true, minChars: 1, mdDir: relDir });
    await registerFactory(h.fakePi, h.cfgPath);
    await h.start();
    await h.handlers["tool_result"]!(
      writeToolResult(`${relDir}/note.md`),
      h.fakeCtx,
    );
    await h.tick();

    expect(existsSync(join(mdDir, "note.plain.md"))).toBe(true);
  });

  test("md hook fails open when the rewriter fails (original untouched)", async () => {
    const mdDir = join(tempDir, "docs4");
    mkdirSync(mdDir, { recursive: true });
    const src = join(mdDir, "doc.md");
    const body = "A long body that will not get rewritten.";
    writeFileSync(src, body);

    // No stub, no model → rewrite fails open, file untouched.
    const h = makeHarness({ minChars: 1, mdDir, mdMode: "overwrite" });
    await registerFactory(h.fakePi, h.cfgPath);
    await h.start();
    await h.handlers["tool_result"]!(
      writeToolResult("docs4/doc.md"),
      h.fakeCtx,
    );
    await h.tick();

    expect(readFileSync(src, "utf8")).toBe(body);
    expect(existsSync(join(mdDir, "doc.plain.md"))).toBe(false);
  });
});
