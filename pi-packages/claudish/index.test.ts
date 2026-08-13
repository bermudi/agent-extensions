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
  MAX_INPUT_CHARS,
  parseConfig,
  PROVIDER_DEFAULT_MODELS,
} from "./config.ts";
import type { ClConfig } from "./config.ts";
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

describe("parseConfig", () => {
  test("defaults match the plugin", () => {
    const c = parseConfig({});
    expect(c.enabled).toBe(true);
    expect(c.offFile).toBe(
      join(process.env.HOME ?? "", ".claude", "claudish-off"),
    );
    expect(c.provider).toBe("ollama");
    expect(c.model).toBe(PROVIDER_DEFAULT_MODELS.ollama);
    expect(c.ollamaUrl).toBe("http://localhost:11434");
    expect(c.anthropicUrl).toBe("https://api.anthropic.com");
    expect(c.openaiUrl).toBe("https://api.openai.com/v1");
    expect(c.openaiEffort).toBe("none"); // api.openai.com gets reasoning_effort: none
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

  test("invalid provider falls back to ollama", () => {
    const c = parseConfig({ CLAUDISH_PROVIDER: "gpt4all" });
    expect(c.provider).toBe("ollama");
  });

  test("provider selection picks defaults per provider", () => {
    const anthro = parseConfig({ CLAUDISH_PROVIDER: "anthropic" });
    expect(anthro.model).toBe(PROVIDER_DEFAULT_MODELS.anthropic);
    const openai = parseConfig({ CLAUDISH_PROVIDER: "openai" });
    expect(openai.model).toBe(PROVIDER_DEFAULT_MODELS.openai);
  });

  test("CLAUDISH_MODEL overrides any provider default", () => {
    const c = parseConfig({ CLAUDISH_MODEL: "llama3.2:3b" });
    expect(c.model).toBe("llama3.2:3b");
  });

  test("effort is omitted for non-api.openai.com endpoints", () => {
    const local = parseConfig({
      CLAUDISH_OPENAI_URL: "http://localhost:1234/v1",
    });
    expect(local.openaiEffort).toBeUndefined();
  });

  test("explicit empty effort omits the field even on api.openai.com", () => {
    const c = parseConfig({ CLAUDISH_OPENAI_EFFORT: "" });
    expect(c.openaiEffort).toBeUndefined();
  });

  test("explicit effort wins", () => {
    const c = parseConfig({ CLAUDISH_OPENAI_EFFORT: "low" });
    expect(c.openaiEffort).toBe("low");
  });

  test("trailing slashes are stripped from URLs", () => {
    const c = parseConfig({
      CLAUDISH_OLLAMA: "http://localhost:11434///",
      CLAUDISH_ANTHROPIC_URL: "https://gateway.example.com/",
      CLAUDISH_OPENAI_URL: "https://proxy.example.com/v1//",
    });
    expect(c.ollamaUrl).toBe("http://localhost:11434");
    expect(c.anthropicUrl).toBe("https://gateway.example.com");
    expect(c.openaiUrl).toBe("https://proxy.example.com/v1");
  });

  test("invalid numeric values fall back, valid ones clamp", () => {
    const bad = parseConfig({
      CLAUDISH_MAX_TOKENS: "abc",
      CLAUDISH_MIN_CHARS: "-3",
      CLAUDISH_TIMEOUT: "0",
      CLAUDISH_MD_TIMEOUT: "999999",
    });
    expect(bad.maxTokens).toBe(4096);
    expect(bad.minChars).toBe(200);
    expect(bad.displayTimeoutMs).toBe(45_000);
    expect(bad.mdTimeoutMs).toBe(150_000); // out-of-range falls back to default

    const good = parseConfig({
      CLAUDISH_MAX_TOKENS: "8192",
      CLAUDISH_MIN_CHARS: "50",
      CLAUDISH_TIMEOUT: "10",
      CLAUDISH_MD_TIMEOUT: "60",
    });
    expect(good.maxTokens).toBe(8192);
    expect(good.minChars).toBe(50);
    expect(good.displayTimeoutMs).toBe(10_000);
    expect(good.mdTimeoutMs).toBe(60_000);
  });

  test("switches parse from 0/1 strings", () => {
    const off = parseConfig({
      CLAUDISH_ENABLED: "0",
      CLAUDISH_STUB: "1",
      CLAUDISH_DEBUG: "1",
      CLAUDISH_NOTICE: "0",
    });
    expect(off.enabled).toBe(false);
    expect(off.stub).toBe(true);
    expect(off.debug).toBe(true);
    expect(off.notice).toBe(false);
  });

  test("md dir is expanded and optional", () => {
    const c = parseConfig({
      CLAUDISH_MD_DIR: "~/docs/plain",
      CLAUDISH_MD_MODE: "overwrite",
    });
    expect(c.mdDir).toBe(join(process.env.HOME ?? "", "docs", "plain"));
    expect(c.mdMode).toBe("overwrite");
    const empty = parseConfig({ CLAUDISH_MD_DIR: "  " });
    expect(empty.mdDir).toBeUndefined();
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
  function configFor(overrides: Record<string, string | undefined>): ClConfig {
    return parseConfig(overrides);
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
      config: configFor({ CLAUDISH_STUB: "1" }),
      text: "hi there",
      timeoutMs: 1000,
      fetchImpl: (() => {
        throw new Error("should not be called");
      }) as FetchLike,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toBe("[claudish stub] hi there");
  });

  test("ollama: ok response returns text", async () => {
    const out = await rewrite({
      config: configFor({ CLAUDISH_PROVIDER: "ollama" }),
      text: "msg",
      timeoutMs: 1000,
      fetchImpl: jsonFetch(200, {
        response: "plain version",
        done_reason: "stop",
      }),
    });
    expect(out).toEqual({ ok: true, text: "plain version" });
  });

  test("ollama: output cap (done_reason length) discards the rewrite", async () => {
    const out = await rewrite({
      config: configFor({ CLAUDISH_PROVIDER: "ollama" }),
      text: "msg",
      timeoutMs: 1000,
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
      config: configFor({
        CLAUDISH_PROVIDER: "anthropic",
        CLAUDISH_ANTHROPIC_KEY: "sk-ant-test",
        CLAUDISH_MODEL: "claude-haiku-4-5",
      }),
      text: "msg",
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(out.ok).toBe(true);
    expect(captured?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured?.headers["x-api-key"]).toBe("sk-ant-test");
    expect(captured?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured?.body.max_tokens).toBe(4096);
    expect(captured?.body.model).toBe("claude-haiku-4-5");
  });

  test("anthropic: missing key fails open", async () => {
    const out = await rewrite({
      config: configFor({ CLAUDISH_PROVIDER: "anthropic" }),
      text: "msg",
      timeoutMs: 1000,
      fetchImpl: jsonFetch(200, {}),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("no API key");
  });

  test("anthropic: max_tokens stop reason discards the rewrite", async () => {
    const out = await rewrite({
      config: configFor({
        CLAUDISH_PROVIDER: "anthropic",
        CLAUDISH_ANTHROPIC_KEY: "k",
      }),
      text: "msg",
      timeoutMs: 1000,
      fetchImpl: jsonFetch(200, {
        content: [{ type: "text", text: "half" }],
        stop_reason: "max_tokens",
      }),
    });
    expect(out.ok).toBe(false);
  });

  test("openai: api.openai.com request carries reasoning_effort none", async () => {
    let captured: { url: string; body: any } | undefined;
    const fetchImpl = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "plain" } }],
          finish_reason: "stop",
        }),
      } as Response;
    }) as FetchLike;

    const out = await rewrite({
      config: configFor({
        CLAUDISH_PROVIDER: "openai",
        CLAUDISH_OPENAI_KEY: "sk-x",
      }),
      text: "msg",
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(out.ok).toBe(true);
    expect(captured?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(captured?.body.reasoning_effort).toBe("none");
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
      config: configFor({
        CLAUDISH_PROVIDER: "openai",
        CLAUDISH_OPENAI_URL: "http://localhost:1234/v1",
      }),
      text: "msg",
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(out.ok).toBe(true);
    expect(captured?.body.reasoning_effort).toBeUndefined();
  });

  test("openai: finish_reason length discards the rewrite", async () => {
    const out = await rewrite({
      config: configFor({
        CLAUDISH_PROVIDER: "openai",
        CLAUDISH_OPENAI_KEY: "k",
      }),
      text: "msg",
      timeoutMs: 1000,
      fetchImpl: jsonFetch(200, {
        choices: [{ message: { content: "half" } }],
        finish_reason: "length",
      }),
    });
    expect(out.ok).toBe(false);
  });

  test("non-ok response fails open", async () => {
    const out = await rewrite({
      config: configFor({ CLAUDISH_PROVIDER: "ollama" }),
      text: "msg",
      timeoutMs: 1000,
      fetchImpl: jsonFetch(500, {}),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("500");
  });

  test("network failure fails open", async () => {
    const out = await rewrite({
      config: configFor({ CLAUDISH_PROVIDER: "ollama" }),
      text: "msg",
      timeoutMs: 1000,
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
      config: configFor({ CLAUDISH_PROVIDER: "ollama" }),
      text: "msg",
      timeoutMs: 50,
      fetchImpl: hanging,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("timeout");
  });
});

// ── index.ts extension wiring ──────────────────────────────────────────────

describe("extension", () => {
  const SAVED_ENV: Record<string, string | undefined> = {};
  // Every var the extension reads — scrub all so no test ever hits the network
  // via ambient keys, and restore them after the run.
  const ENV_KEYS = [
    "CLAUDISH_ENABLED",
    "CLAUDISH_OFF_FILE",
    "CLAUDISH_PROVIDER",
    "CLAUDISH_MODEL",
    "CLAUDISH_STUB",
    "CLAUDISH_MIN_CHARS",
    "CLAUDISH_NOTICE",
    "CLAUDISH_MD_DIR",
    "CLAUDISH_MD_MODE",
    "CLAUDISH_MD_SUFFIX",
    "CLAUDISH_ANTHROPIC_KEY",
    "CLAUDISH_OPENAI_KEY",
    "CLAUDISH_ANTHROPIC_URL",
    "CLAUDISH_OPENAI_URL",
    "CLAUDISH_OLLAMA",
    "CLAUDISH_MAX_TOKENS",
    "CLAUDISH_TIMEOUT",
    "CLAUDISH_MD_TIMEOUT",
    "CLAUDISH_DEBUG",
    "CLAUDISH_OPENAI_EFFORT",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ];

  let tempDir: string;

  beforeAll(() => {
    for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
    tempDir = mkdtempSync(join(tmpdir(), "claudish-test-"));
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (SAVED_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED_ENV[k];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeHarness(env: Record<string, string>) {
    // Scrub every var the extension reads, then apply overrides.
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    process.env.CLAUDISH_OFF_FILE = join(tempDir, "off");

    const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
    const appended: Array<{ customType: string; data: unknown }> = [];
    const notifications: Array<{ message: string; level?: string }> = [];
    const sessionEntries: any[] = [];

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
    };

    return {
      fakePi,
      fakeCtx,
      handlers,
      appended,
      notifications,
      sessionEntries,
      start: async () => {
        await handlers["session_start"]!(
          { type: "session_start", reason: "startup" },
          fakeCtx,
        );
      },
      tick: () => new Promise((r) => setTimeout(r, 20)),
    };
  }

  async function registerFactory(fakePi: unknown) {
    const { default: factory } = await import("./index.ts");
    factory(fakePi as never);
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

  test("display hook appends a rewrite entry for assistant text", async () => {
    const h = makeHarness({ CLAUDISH_STUB: "1", CLAUDISH_MIN_CHARS: "1" });
    await registerFactory(h.fakePi);
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
    const h = makeHarness({ CLAUDISH_STUB: "1", CLAUDISH_MIN_CHARS: "1" });
    await registerFactory(h.fakePi);
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
    const h = makeHarness({ CLAUDISH_STUB: "1", CLAUDISH_MIN_CHARS: "200" });
    await registerFactory(h.fakePi);
    await h.start();
    await h.handlers["message_end"]!(assistantMessage("tiny"), h.fakeCtx);
    await h.tick();
    expect(h.appended).toHaveLength(0);
  });

  test("kill switch pauses rewrites mid-session", async () => {
    const h = makeHarness({ CLAUDISH_STUB: "1", CLAUDISH_MIN_CHARS: "1" });
    await registerFactory(h.fakePi);
    await h.start();
    writeFileSync(process.env.CLAUDISH_OFF_FILE!, "");
    await h.handlers["message_end"]!(
      assistantMessage("Something long enough."),
      h.fakeCtx,
    );
    await h.tick();
    expect(h.appended).toHaveLength(0);
    rmSync(process.env.CLAUDISH_OFF_FILE!, { force: true });
  });

  test("CLAUDISH_ENABLED=0 disables the display hook", async () => {
    const h = makeHarness({
      CLAUDISH_STUB: "1",
      CLAUDISH_MIN_CHARS: "1",
      CLAUDISH_ENABLED: "0",
    });
    await registerFactory(h.fakePi);
    await h.start();
    await h.handlers["message_end"]!(
      assistantMessage("Something long enough."),
      h.fakeCtx,
    );
    await h.tick();
    expect(h.appended).toHaveLength(0);
  });

  test("notice fires once per session even across repeated failures", async () => {
    const h = makeHarness({
      CLAUDISH_PROVIDER: "anthropic", // no key anywhere → fails open
      CLAUDISH_MIN_CHARS: "1",
      CLAUDISH_NOTICE: "1",
    });
    await registerFactory(h.fakePi);
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

  test("md hook writes a sibling file for markdown written under CLAUDISH_MD_DIR", async () => {
    const mdDir = join(tempDir, "docs");
    mkdirSync(mdDir, { recursive: true });
    const src = join(mdDir, "plan.md");
    writeFileSync(
      src,
      "---\ntitle: Plan\n---\n# The plan\nDetailed prose body for rewriting.",
    );

    const h = makeHarness({
      CLAUDISH_STUB: "1",
      CLAUDISH_MIN_CHARS: "1",
      CLAUDISH_MD_DIR: mdDir,
    });
    await registerFactory(h.fakePi);
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
    expect(readFileSync(src, "utf8")).not.toContain("[claudish stub]"); // original untouched
  });

  test("md hook overwrites in place with an idempotent marker", async () => {
    const mdDir = join(tempDir, "docs2");
    mkdirSync(mdDir, { recursive: true });
    const src = join(mdDir, "spec.md");
    const body =
      "# Spec\nA very long and detailed body that qualifies for a rewrite.";
    writeFileSync(src, body);

    const h = makeHarness({
      CLAUDISH_STUB: "1",
      CLAUDISH_MIN_CHARS: "1",
      CLAUDISH_MD_DIR: mdDir,
      CLAUDISH_MD_MODE: "overwrite",
    });
    await registerFactory(h.fakePi);
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

  test("md hook ignores non-md files and files outside CLAUDISH_MD_DIR", async () => {
    const mdDir = join(tempDir, "docs3");
    mkdirSync(mdDir, { recursive: true });
    const inside = join(mdDir, "a.md");
    writeFileSync(inside, "A sufficiently long body inside the directory.");
    const outside = join(tempDir, "outside.md");
    writeFileSync(outside, "A sufficiently long body outside the directory.");
    const notMd = join(mdDir, "b.txt");
    writeFileSync(notMd, "A sufficiently long body that is not markdown.");

    const h = makeHarness({
      CLAUDISH_STUB: "1",
      CLAUDISH_MIN_CHARS: "1",
      CLAUDISH_MD_DIR: mdDir,
    });
    await registerFactory(h.fakePi);
    await h.start();
    await h.handlers["tool_result"]!(writeToolResult("outside.md"), h.fakeCtx);
    await h.handlers["tool_result"]!(writeToolResult("docs3/b.txt"), h.fakeCtx);
    await h.handlers["tool_result"]!(writeToolResult("docs3/a.md"), h.fakeCtx);
    await h.tick();

    expect(existsSync(join(tempDir, "outside.plain.md"))).toBe(false);
    expect(existsSync(join(mdDir, "b.plain.txt"))).toBe(false);
    expect(existsSync(join(mdDir, "a.plain.md"))).toBe(true);
  });

  test("md hook fails open when the rewriter fails (original untouched)", async () => {
    const mdDir = join(tempDir, "docs4");
    mkdirSync(mdDir, { recursive: true });
    const src = join(mdDir, "doc.md");
    const body = "A long body that will not get rewritten.";
    writeFileSync(src, body);

    const h = makeHarness({
      CLAUDISH_PROVIDER: "anthropic", // no key → fails
      CLAUDISH_MIN_CHARS: "1",
      CLAUDISH_MD_DIR: mdDir,
      CLAUDISH_MD_MODE: "overwrite",
    });
    await registerFactory(h.fakePi);
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
