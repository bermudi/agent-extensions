import { describe, expect, test } from "bun:test";
import {
  initTheme,
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import reviewExtension, {
  buildCommitRange,
  buildFastFixPrompt,
  buildReviewPrompt,
  buildSelectOptions,
  commitsNewerThan,
  completeReviewArgument,
  getFinalReviewMessage,
  parseArgs,
  parseCommitRange,
  parsePrReference,
  parseReviewPaths,
  tokenizeArgs,
} from "./review";

describe("buildSelectOptions (non-TUI select fallback)", () => {
  test("description rides inline in the label; bare labels pass through", () => {
    const { options, valueFor } = buildSelectOptions([
      { value: "a", label: "Review uncommitted changes", description: "" },
      {
        value: "b",
        label: "Review against a base branch",
        description: "(local or origin/*)",
      },
      { value: "c", label: "Review a commit" },
    ]);
    expect(options).toEqual([
      "Review uncommitted changes",
      "Review against a base branch (local or origin/*)",
      "Review a commit",
    ]);
    expect(valueFor("Review a commit")).toBe("c");
    expect(valueFor("Review uncommitted changes")).toBe("a");
    expect(valueFor("unknown option")).toBeUndefined();
  });

  test("recommended index gets a suffix and still maps back to its value", () => {
    const { options, valueFor } = buildSelectOptions(
      [
        { value: "uncommitted", label: "Review uncommitted changes" },
        { value: "commit", label: "Review a commit" },
      ],
      1,
    );
    expect(options).toEqual([
      "Review uncommitted changes",
      "Review a commit (recommended)",
    ]);
    expect(valueFor("Review a commit (recommended)")).toBe("commit");
    expect(valueFor("Review a commit")).toBeUndefined();
  });
});

describe("/review argument completion", () => {
  test("verbs complete with trailing space only when they take a value", () => {
    expect(completeReviewArgument("")?.map((i) => i.value)).toEqual([
      "uncommitted",
      "branch ",
      "commit ",
      "range ",
      "folder ",
      "pr ",
      "--extra ",
    ]);
    expect(completeReviewArgument("br")).toEqual([
      { value: "branch ", label: "branch" },
    ]);
    expect(completeReviewArgument("--e")).toEqual([
      { value: "--extra ", label: "--extra" },
    ]);
    expect(completeReviewArgument("x")).toBeNull();
  });

  test("values stay free-form: null falls back to file completion", () => {
    expect(completeReviewArgument("branch ")).toBeNull();
    expect(completeReviewArgument("folder src/")).toBeNull();
    expect(completeReviewArgument("pr 123")).toBeNull();
    expect(completeReviewArgument("uncommitted ")).toBeNull();
  });

  test("partial flag completes past the verb; unknown flags do not", () => {
    expect(completeReviewArgument("uncommitted --e")).toEqual([
      { value: "--extra ", label: "--extra" },
    ]);
    expect(completeReviewArgument("uncommitted --bogus")).toBeNull();
  });
});

describe("parsePrReference", () => {
  test("bare number returns prNumber with no repo", () => {
    expect(parsePrReference("123")).toEqual({ prNumber: 123 });
    expect(parsePrReference("  456  ")).toEqual({ prNumber: 456 });
  });

  test("garbage with trailing letters is rejected (parseInt('123abc') → 123 was the bug)", () => {
    expect(parsePrReference("123abc")).toBeNull();
    expect(parsePrReference("abc")).toBeNull();
    expect(parsePrReference("12.5")).toBeNull();
  });

  test("zero and negative numbers are rejected", () => {
    expect(parsePrReference("0")).toBeNull();
    expect(parsePrReference("-1")).toBeNull();
  });

  test("GitHub URL extracts owner/repo and pr number", () => {
    expect(parsePrReference("https://github.com/owner/repo/pull/123")).toEqual({
      prNumber: 123,
      repo: "owner/repo",
    });
  });

  test("GitHub URL without protocol matches", () => {
    expect(parsePrReference("github.com/owner/repo/pull/456")).toEqual({
      prNumber: 456,
      repo: "owner/repo",
    });
  });

  test("URL with trailing .git strips it from the repo slug", () => {
    expect(
      parsePrReference("https://github.com/owner/repo.git/pull/789"),
    ).toEqual({ prNumber: 789, repo: "owner/repo" });
  });

  test("URL with query params or fragments still extracts the PR number", () => {
    expect(
      parsePrReference("https://github.com/owner/repo/pull/42/files#diff-abc"),
    ).toEqual({ prNumber: 42, repo: "owner/repo" });
  });

  test("non-GitHub URL is rejected", () => {
    expect(
      parsePrReference("https://gitlab.com/owner/repo/merge_requests/1"),
    ).toBeNull();
  });

  test("GitHub URL without /pull/ path is rejected", () => {
    expect(
      parsePrReference("https://github.com/owner/repo/issues/123"),
    ).toBeNull();
  });

  test("malformed PR number with trailing letters is rejected (numeric prefix bug)", () => {
    // Regression: the URL regex matched a numeric prefix, so /pull/123abc
    // silently resolved as PR 123. The trailing anchor ([/?#]|$) now rejects
    // any reference where the digits aren't followed by /, ?, #, or end.
    expect(
      parsePrReference("https://github.com/owner/repo/pull/123abc"),
    ).toBeNull();
    expect(
      parsePrReference("https://github.com/owner/repo/pull/42xyz"),
    ).toBeNull();
    expect(parsePrReference("github.com/owner/repo/pull/999foo")).toBeNull();
  });

  test("PR number followed by a subpath, query, or fragment is accepted", () => {
    // The anchor must still allow legitimate suffixes: /files, ?diff=1, #diff.
    expect(
      parsePrReference("https://github.com/owner/repo/pull/123/files"),
    ).toEqual({ prNumber: 123, repo: "owner/repo" });
    expect(
      parsePrReference("https://github.com/owner/repo/pull/123?diff=1"),
    ).toEqual({ prNumber: 123, repo: "owner/repo" });
    expect(
      parsePrReference("https://github.com/owner/repo/pull/123#discussion"),
    ).toEqual({ prNumber: 123, repo: "owner/repo" });
    expect(parsePrReference("https://github.com/owner/repo/pull/123/")).toEqual(
      { prNumber: 123, repo: "owner/repo" },
    );
  });
});

describe("tokenizeArgs", () => {
  // Table test: the two bugs a 15-line table test would have caught were
  //   1. Backslash escaping inside single quotes (POSIX: literal, not escape)
  //   2. Empty quoted strings silently dropped (should produce "" token)
  test.each([
    ["basic words", "foo bar", ["foo", "bar"]],
    ["single-quoted phrase", "'hello world'", ["hello world"]],
    ["double-quoted phrase", '"hello world"', ["hello world"]],
    ["mixed quoting", 'foo "bar baz" qux', ["foo", "bar baz", "qux"]],
    [
      "empty double quotes produce empty token",
      'foo "" bar',
      ["foo", "", "bar"],
    ],
    [
      "empty single quotes produce empty token",
      "foo '' bar",
      ["foo", "", "bar"],
    ],
    ["lone empty double quotes", '""', [""]],
    ["lone empty single quotes", "''", [""]],
    ["backslash escape inside double quotes", '"say \\\"hi\\\""', ['say "hi"']],
    [
      "backslash is literal inside single quotes (POSIX)",
      "'it\\'s'",
      ["it\\s"],
    ],
    [
      "single-quote close after literal backslash",
      "'it\\'s done'",
      ["it\\s", "done"],
    ],
    ["unquoted backslash-space joins", "foo\\ bar", ["foo bar"]],
    ["unquoted backslash-rm strips backslash", "\\rm", ["rm"]],
    ["no args", "", []],
    ["only whitespace", "   ", []],
    ["trailing whitespace", "foo  ", ["foo"]],
    ["leading whitespace", "  foo", ["foo"]],
    ["multiple spaces between", "foo    bar", ["foo", "bar"]],
    ["tabs as separators", "foo\tbar", ["foo", "bar"]],
    ["newlines as separators", "foo\nbar", ["foo", "bar"]],
    ["mid-word quotes concatenate", 'foo"bar"baz', ["foobarbaz"]],
    ["mid-word single quotes concatenate", "foo'bar'baz", ["foobarbaz"]],
    [
      "--extra=value with spaces in quotes",
      '--extra="focus on security"',
      ["--extra=focus on security"],
    ],
    ["nested quotes", "\"outer 'inner' outer\"", ["outer 'inner' outer"]],
  ])("%s", (_label, input, expected) => {
    expect(tokenizeArgs(input)).toEqual(expected);
  });
});

describe("parseArgs folder flow", () => {
  test("quoted path with spaces stays one path (regression: join+re-split destroyed it)", () => {
    expect(parseArgs('folder "My Stuff"')).toEqual({
      target: { type: "folder", paths: ["My Stuff"] },
      extraInstruction: undefined,
    });
    expect(parseArgs("folder 'My Stuff' docs")).toEqual({
      target: { type: "folder", paths: ["My Stuff", "docs"] },
      extraInstruction: undefined,
    });
  });

  test("adjacent separately-quoted paths stay separate tokens", () => {
    // Regression guard for the removed join(" ") round trip: re-tokenizing a
    // re-joined string would merge these into one "My Stuff" path.
    expect(parseArgs('folder "My" "Stuff"')).toEqual({
      target: { type: "folder", paths: ["My", "Stuff"] },
      extraInstruction: undefined,
    });
  });

  test("unquoted paths and --extra still parse", () => {
    expect(parseArgs("folder src docs")).toEqual({
      target: { type: "folder", paths: ["src", "docs"] },
      extraInstruction: undefined,
    });
    expect(parseArgs('folder "My Stuff" --extra "focus on types"')).toEqual({
      target: { type: "folder", paths: ["My Stuff"] },
      extraInstruction: "focus on types",
    });
  });

  test("empty quoted paths are dropped, not turned into a broken path", () => {
    expect(parseArgs('folder "" src')).toEqual({
      target: { type: "folder", paths: ["src"] },
      extraInstruction: undefined,
    });
  });
});

describe("parseReviewPaths (folder editor flow)", () => {
  test("quoted path with spaces survives tokenization", () => {
    expect(parseReviewPaths(tokenizeArgs('"My Stuff"'))).toEqual(["My Stuff"]);
  });

  test("space-separated and one-per-line entries both split (editor contract)", () => {
    expect(parseReviewPaths(tokenizeArgs("src docs"))).toEqual(["src", "docs"]);
    expect(parseReviewPaths(tokenizeArgs("src\ndocs"))).toEqual([
      "src",
      "docs",
    ]);
  });

  test("mixed quoted and unquoted lines", () => {
    expect(parseReviewPaths(tokenizeArgs('src\n"My Stuff"\ndocs'))).toEqual([
      "src",
      "My Stuff",
      "docs",
    ]);
  });

  test("whitespace inside quotes is kept, surrounding empties filtered", () => {
    expect(parseReviewPaths(tokenizeArgs('  "My Stuff"  '))).toEqual([
      "My Stuff",
    ]);
    expect(parseReviewPaths(tokenizeArgs('""'))).toEqual([]);
  });
});

describe("parseCommitRange", () => {
  test("two-dot and three-dot ranges parse with endpoints kept verbatim", () => {
    expect(parseCommitRange("abc123..def456")).toEqual({
      from: "abc123",
      to: "def456",
      threeDot: false,
      range: "abc123..def456",
    });
    expect(parseCommitRange("main...HEAD")).toEqual({
      from: "main",
      to: "HEAD",
      threeDot: true,
      range: "main...HEAD",
    });
    expect(parseCommitRange("v1.2..HEAD~3")).toEqual({
      from: "v1.2",
      to: "HEAD~3",
      threeDot: false,
      range: "v1.2..HEAD~3",
    });
  });

  test("malformed ranges are rejected", () => {
    expect(parseCommitRange("abc123")).toBeNull();
    expect(parseCommitRange("..HEAD")).toBeNull();
    expect(parseCommitRange("abc123..")).toBeNull();
    expect(parseCommitRange("abc123...")).toBeNull();
    expect(parseCommitRange("a..b..c")).toBeNull();
    expect(parseCommitRange("a....b")).toBeNull();
    expect(parseCommitRange("-a..b")).toBeNull();
    expect(parseCommitRange("a..-b")).toBeNull();
  });

  test("shell metacharacters in endpoints are rejected (prompt embeds the range in agent-run commands)", () => {
    expect(parseCommitRange("a..b;id")).toBeNull();
    expect(parseCommitRange("a..b$(id)")).toBeNull();
    expect(parseCommitRange("a..b`id`")).toBeNull();
    expect(parseCommitRange("a..b|id")).toBeNull();
    expect(parseCommitRange("a..b&id")).toBeNull();
    expect(parseCommitRange("a;b..c")).toBeNull();
    expect(parseCommitRange("a..b>c")).toBeNull();
    expect(parseArgs("commit a..b;id")).toMatchObject({
      target: null,
      error: expect.stringContaining("Invalid commit range"),
    });
    // Legitimate rev syntax still parses.
    expect(parseCommitRange("feat/x-1..HEAD@{1}")).not.toBeNull();
    expect(parseCommitRange("v1.2.3..release/2.0~3")).not.toBeNull();
  });
});

describe("parseArgs commit ranges", () => {
  test("commit <range> and range verbs produce a commitRange target", () => {
    const expected = {
      target: {
        type: "commitRange",
        range: "abc123..def456",
        from: "abc123",
        to: "def456",
        threeDot: false,
      },
      extraInstruction: undefined,
    };
    expect(parseArgs("commit abc123..def456")).toEqual(expected);
    expect(parseArgs("range abc123..def456")).toEqual(expected);
    expect(parseArgs("range abc123 def456")).toEqual(expected);
    expect(parseArgs("range main...HEAD")).toEqual({
      target: {
        type: "commitRange",
        range: "main...HEAD",
        from: "main",
        to: "HEAD",
        threeDot: true,
      },
      extraInstruction: undefined,
    });
    expect(parseArgs('range abc..def --extra "focus on perf"')).toEqual({
      ...expected,
      target: { ...expected.target, range: "abc..def", from: "abc", to: "def" },
      extraInstruction: "focus on perf",
    });
  });

  test("single commit still parses as commit; malformed range errors", () => {
    expect(parseArgs("commit abc123")).toEqual({
      target: { type: "commit", sha: "abc123", title: undefined },
      extraInstruction: undefined,
    });
    expect(parseArgs("commit abc..")).toMatchObject({
      target: null,
      error: expect.stringContaining("Invalid commit range"),
    });
    expect(parseArgs("range abc")).toMatchObject({
      target: null,
      error: expect.stringContaining("Invalid commit range"),
    });
  });
});

describe("range picker helpers", () => {
  // git log order: newest first.
  const commits = [
    { sha: "c333333", title: "third commit" },
    { sha: "b222222", title: "second commit" },
    { sha: "a111111", title: "first commit" },
  ];

  test("head candidates are only commits newer than the picked start", () => {
    expect(commitsNewerThan(commits, "a111111")).toEqual(commits.slice(0, 2));
    expect(commitsNewerThan(commits, "b222222")).toEqual(commits.slice(0, 1));
    expect(commitsNewerThan(commits, "c333333")).toEqual([]);
    expect(commitsNewerThan(commits, "unknown")).toEqual([]);
  });

  test("buildCommitRange assembles two-dot and three-dot targets", () => {
    expect(buildCommitRange("a111111", "c333333", false)).toEqual({
      type: "commitRange",
      range: "a111111..c333333",
      from: "a111111",
      to: "c333333",
      threeDot: false,
    });
    expect(buildCommitRange("a111111", "c333333", true)).toEqual({
      type: "commitRange",
      range: "a111111...c333333",
      from: "a111111",
      to: "c333333",
      threeDot: true,
    });
    expect(buildCommitRange("", "c333333", false)).toBeNull();
  });
});

describe("/review commit-range picker (RPC select flow)", () => {
  const LOG =
    "c333333 third commit\nb222222 second commit\na111111 first commit\n";

  function setupPickerHarness(selectQueue: Array<string | undefined>) {
    const handlers = new Map<
      string,
      (args: string, ctx: ExtensionCommandContext) => Promise<void>
    >();
    const notifications: string[] = [];
    const sent: string[] = [];
    const selectCalls: Array<{ title: string; options: string[] }> = [];
    const queue = [...selectQueue];

    const pi = {
      on: () => {},
      registerCommand: (
        name: string,
        command: {
          handler: (
            args: string,
            ctx: ExtensionCommandContext,
          ) => Promise<void>;
        },
      ) => handlers.set(name, command.handler),
      appendEntry: () => {},
      exec: async (_cmd: string, args: string[]) => {
        if (args[0] === "log") return { stdout: LOG, code: 0, stderr: "" };
        if (args[0] === "status") return { stdout: "", code: 0, stderr: "" };
        if (args[0] === "branch" && args[1] === "--show-current")
          return { stdout: "main\n", code: 0, stderr: "" };
        if (args[0] === "symbolic-ref")
          return { stdout: "origin/main\n", code: 0, stderr: "" };
        return { stdout: "", code: 0, stderr: "" };
      },
      sendUserMessage: (text: string) => sent.push(text),
    } as unknown as ExtensionAPI;
    reviewExtension(pi);

    const ctx = {
      hasUI: true,
      mode: "rpc",
      cwd: "/",
      sessionManager: {
        getBranch: () => [],
        // One existing message → "Current session" mode, so executeReview
        // never sets the module-level review-origin state other suites use.
        getEntries: () => [
          { type: "message", message: { role: "user", content: "hi" } },
        ],
        getLeafId: () => "leaf-1",
      },
      ui: {
        select: async (title: string, options: string[]) => {
          selectCalls.push({ title, options });
          return queue.shift();
        },
        notify: (message: string) => notifications.push(message),
        editor: async () => undefined,
        setWidget: () => {},
        setEditorText: () => {},
        getEditorText: () => "",
        custom: async () => undefined,
      },
      navigateTree: async () => ({ cancelled: false }),
    } as unknown as ExtensionCommandContext;

    const handler = handlers.get("review");
    if (!handler) throw new Error("review command was not registered");
    return { run: () => handler("", ctx), notifications, sent, selectCalls };
  }

  test("two picks + three-dot choice reviews the assembled range", async () => {
    const harness = setupPickerHarness([
      "Review a commit range (A..B or A...B)",
      "a111111 first commit",
      "c333333 third commit",
      "Three-dot (A...B) — merge-base diff",
      "Current session",
    ]);
    await harness.run();

    expect(harness.selectCalls.map((c) => c.title)).toEqual([
      "Select a review preset",
      "Select starting commit (older, excluded from the range)",
      "Select ending commit (newer, included in the range)",
      "Select range type",
      "Start review in:",
    ]);
    // The ending list cannot offer the start commit or anything older.
    expect(harness.selectCalls[2]?.options).toEqual([
      "c333333 third commit",
      "b222222 second commit",
    ]);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toContain("commit range a111111...c333333");
    expect(harness.sent[0]).toContain("merge base");
  });

  test("picking the newest commit as start returns to the preset menu", async () => {
    const harness = setupPickerHarness([
      "Review a commit range (A..B or A...B)",
      "c333333 third commit",
      undefined, // cancel the re-shown preset menu
    ]);
    await harness.run();

    expect(harness.sent).toEqual([]);
    expect(harness.notifications).toContain(
      "Starting commit is the newest commit — pick an older starting commit.",
    );
    expect(harness.notifications).toContain("Review cancelled");
  });
});

describe("buildReviewPrompt ($-pattern safety)", () => {
  // User-controlled strings passed as the replacement of String.replace let
  // `$&`, `` $` ``, and `$'` splice matched/left/right template context into
  // the prompt. They must reach the prompt verbatim instead.
  const nasty = "Fix $& bug `x` $' $` tail";

  function piStub(
    exec?: (
      cmd: string,
      args: string[],
    ) => Promise<{ stdout: string; code: number }>,
  ): ExtensionAPI {
    return {
      exec: exec ?? (async () => ({ stdout: "", code: 1 })),
    } as unknown as ExtensionAPI;
  }

  test("commit title round-trips verbatim", async () => {
    const prompt = await buildReviewPrompt(piStub(), {
      type: "commit",
      sha: "abc1234",
      title: nasty,
    });
    expect(prompt).toContain(`("${nasty}")`);
    expect(prompt).toContain("commit abc1234");
  });

  test("commit sha (user arg) round-trips verbatim", async () => {
    const prompt = await buildReviewPrompt(piStub(), {
      type: "commit",
      sha: "dead$&beef",
    });
    expect(prompt).toContain("commit dead$&beef");
  });

  test("branch name round-trips verbatim (merge-base found)", async () => {
    const prompt = await buildReviewPrompt(
      piStub(async () => ({ stdout: "deadbeef123\n", code: 0 })),
      { type: "baseBranch", branch: "feat/$&-$`-fix" },
    );
    expect(prompt).toContain("'feat/$&-$`-fix'");
    expect(prompt).toContain("deadbeef123");
  });

  test("branch name round-trips verbatim (no merge-base)", async () => {
    const prompt = await buildReviewPrompt(piStub(), {
      type: "baseBranch",
      branch: "feat/$'-fix",
    });
    expect(prompt).toContain("'feat/$'-fix'");
  });

  test("PR title and base branch round-trip verbatim", async () => {
    const prompt = await buildReviewPrompt(
      piStub(async () => ({ stdout: "deadbeef123\n", code: 0 })),
      {
        type: "pullRequest",
        prNumber: 42,
        baseBranch: "main$`",
        title: "Fix $& crash $'",
      },
    );
    expect(prompt).toContain('"Fix $& crash $\'"');
    expect(prompt).toContain("'main$`'");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("deadbeef123");
  });

  test("commit range prompt names the range and the git commands", async () => {
    const prompt = await buildReviewPrompt(piStub(), {
      type: "commitRange",
      range: "abc123..def456",
      from: "abc123",
      to: "def456",
      threeDot: false,
    });
    expect(prompt).toContain("commit range abc123..def456");
    expect(prompt).toContain("git log --oneline abc123..def456");
    expect(prompt).toContain("git diff abc123..def456");
  });

  test("commit range prompt lists commits when git log succeeds", async () => {
    const prompt = await buildReviewPrompt(
      piStub(async (_cmd, args) =>
        args[0] === "log"
          ? { stdout: "def456 feat: x\nabc123 fix: $& y\n", code: 0 }
          : { stdout: "", code: 1 },
      ),
      {
        type: "commitRange",
        range: "abc..def",
        from: "abc",
        to: "def",
        threeDot: true,
      },
    );
    expect(prompt).toContain("def456 feat: x");
    expect(prompt).toContain("abc123 fix: $& y");
    expect(prompt).toContain("merge base");
  });

  test("three-dot range lists commits with the two-dot log range (the diff's actual commit set)", async () => {
    const calls: string[][] = [];
    const stub = piStub(async (_cmd, args) => {
      calls.push(args);
      return { stdout: "def456 feat: x\n", code: 0 };
    });
    const prompt = await buildReviewPrompt(stub, {
      type: "commitRange",
      range: "main...feature",
      from: "main",
      to: "feature",
      threeDot: true,
    });
    // git log A...B is a symmetric difference (includes main-only commits
    // on diverged endpoints); the reviewed diff A...B contains only
    // merge-base..feature commits, which is exactly git log main..feature.
    expect(calls).toEqual([["log", "--oneline", "-n", "101", "main..feature"]]);
    expect(prompt).toContain("commit range main...feature");
    expect(prompt).toContain("git diff main...feature");
  });

  test("three-dot fallback prompt tells the agent to log two-dot but diff three-dot", async () => {
    const prompt = await buildReviewPrompt(piStub(), {
      type: "commitRange",
      range: "main...feature",
      from: "main",
      to: "feature",
      threeDot: true,
    });
    expect(prompt).toContain("git log --oneline main..feature");
    expect(prompt).toContain("git diff main...feature");
    expect(prompt).not.toContain("git log --oneline main...feature");
  });

  test("commit list is capped at 100 with a truncation note", async () => {
    const many = Array.from(
      { length: 150 },
      (_, i) => `sha${String(i + 1).padStart(3, "0")} commit ${i + 1}`,
    ).join("\n");
    const prompt = await buildReviewPrompt(
      piStub(async () => ({ stdout: `${many}\n`, code: 0 })),
      {
        type: "commitRange",
        range: "abc..def",
        from: "abc",
        to: "def",
        threeDot: false,
      },
    );
    expect(prompt).toContain("commit 100");
    expect(prompt).not.toContain("commit 101");
    expect(prompt).toContain("truncated");
    expect(prompt).toContain("git log --oneline abc..def");
  });

  test("folder paths round-trip verbatim", async () => {
    const prompt = await buildReviewPrompt(piStub(), {
      type: "folder",
      paths: ["src/$&dir", "my $'stuff"],
    });
    expect(prompt).toContain("src/$&dir, my $'stuff");
  });
});

// ---- /end-review harness -------------------------------------------------
// Drives the real /end-review command handler with stub pi/ctx so both the
// loader abort path (navigateWithSummary) and the fix-findings fast path are
// exercised end to end.

const REVIEW_STATE_CUSTOM_TYPE = "review-session";

const activeReviewEntry = {
  type: "custom",
  customType: REVIEW_STATE_CUSTOM_TYPE,
  data: { active: true, originId: "origin-1" },
};

type SummaryLoaderStub = {
  onAbort?: () => void;
  dispose?: () => void;
  handleInput?: (data: string) => void;
};

// BorderedLoader.onAbort is a set-only accessor (reading it yields
// undefined), so tests press the real cancel key instead: handleInput
// routes to CancellableLoader, which aborts and fires onAbort.
const pressEscape = (loader: SummaryLoaderStub) => {
  if (!loader.handleInput) {
    throw new Error("loader has no handleInput; cannot simulate Esc");
  }
  loader.handleInput("\x1b");
};

type NavigateResult = { cancelled: boolean };
type NavigateCall = { targetId: string; options: unknown };
type SentMessage = { text: string; options?: unknown };

const settleMacrotask = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

type HarnessOptions = {
  /** Root→leaf (chronological) entries for the current branch — the order
   * pi's SessionManager.getBranch() actually returns (the leaf is LAST). */
  branchEntries?: unknown[];
  /** Entries returned for getBranch(originId) when the origin sits on a
   * different chain than the leaf (the normal fresh-review shape). */
  originBranchEntries?: unknown[];
  /** Which option the /end-review select dialog resolves with. */
  selectChoice?: string;
  /** When set, navigateTree resolves immediately instead of hand-cranking. */
  autoResolveNavigation?: NavigateResult;
};

function setupEndReviewHarness(options: HarnessOptions = {}) {
  // BorderedLoader's constructor reads pi's global theme (keyHint), which
  // throws "Theme not initialized" in tests unless initialized.
  initTheme();
  const branchEntries = options.branchEntries ?? [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const notifications: string[] = [];
  const widgetCalls: unknown[] = [];
  const editorTexts: string[] = [];
  const sentMessages: SentMessage[] = [];
  const navigateCalls: NavigateCall[] = [];
  const handlers = new Map<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void>
  >();

  let resolveNavigation: (result: NavigateResult) => void = () => {};
  let loader: SummaryLoaderStub | undefined;

  const pi = {
    on: () => {},
    registerCommand: (
      name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => {
      handlers.set(name, command.handler);
    },
    appendEntry: (customType: string, data?: unknown) => {
      appended.push({ customType, data });
    },
    exec: async () => ({ stdout: "", code: 1, stderr: "" }),
    sendUserMessage: (text: string, messageOptions?: unknown) => {
      sentMessages.push({ text, options: messageOptions });
    },
  } as unknown as ExtensionAPI;

  reviewExtension(pi);

  const tui = { requestRender: () => {} };
  const theme = new Proxy(
    {},
    {
      get: () => (style: unknown, text?: unknown) =>
        String(text ?? style ?? ""),
    },
  );

  // getBranch(fromId?) mirrors the real semantics closely enough for these
  // paths: no arg → the current branch in root→leaf (chronological) order,
  // exactly like pi's SessionManager.getBranch(); an id resolves that
  // entry's chain back to the root (a prefix ending at that entry); an id
  // from another chain comes from originBranchEntries; an unknown id
  // yields [] like a real session with no such entry.
  const getBranch = (fromId?: string): unknown[] => {
    if (fromId === undefined) return branchEntries;
    if (options.originBranchEntries) return options.originBranchEntries;
    const index = branchEntries.findIndex((entry) => entry.id === fromId);
    return index === -1 ? [] : branchEntries.slice(0, index + 1);
  };

  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: "/",
    sessionManager: {
      getBranch,
      getEntries: () => branchEntries,
    },
    ui: {
      select: async () => options.selectChoice ?? "Return and summarize",
      notify: (message: string) => {
        notifications.push(message);
      },
      setWidget: (_name: string, widget: unknown) => {
        widgetCalls.push(widget);
      },
      getEditorText: () => "",
      setEditorText: (text: string) => {
        editorTexts.push(text);
      },
      // Mirrors pi's showExtensionCustom: run the factory synchronously,
      // resolve with the first done() call, dispose the component on close.
      custom: (
        factory: (
          tui: typeof tui,
          theme: unknown,
          keybindings: { matches: () => boolean },
          done: (result: unknown) => void,
        ) => SummaryLoaderStub,
      ) =>
        new Promise((resolve) => {
          const done = (result: unknown) => {
            try {
              loader?.dispose?.();
            } catch {
              /* pi ignores dispose errors on close too */
            }
            resolve(result);
          };
          loader = factory(tui, theme, { matches: () => false }, done);
        }),
    },
    navigateTree: async (targetId: string, navOptions?: unknown) => {
      navigateCalls.push({ targetId, options: navOptions });
      if (options.autoResolveNavigation) {
        return options.autoResolveNavigation;
      }
      return new Promise<NavigateResult>((resolve) => {
        resolveNavigation = resolve;
      });
    },
  } as unknown as ExtensionCommandContext;

  const endReviewHandler = handlers.get("end-review");
  if (!endReviewHandler) {
    throw new Error("end-review command was not registered");
  }

  return {
    appended,
    notifications,
    widgetCalls,
    editorTexts,
    sentMessages: () => sentMessages,
    navigateCallCount: () => navigateCalls.length,
    navigationCalls: () => navigateCalls,
    // Delegate to the current binding: navigateTree reassigns
    // resolveNavigation when the handler actually calls it.
    resolveNavigation: (result: NavigateResult) => resolveNavigation(result),
    runEndReview: () => endReviewHandler("", ctx),
    loader: () => loader,
  };
}

async function waitForLoader(
  harness: ReturnType<typeof setupEndReviewHarness>,
): Promise<SummaryLoaderStub> {
  for (let i = 0; i < 100 && !harness.loader(); i++) {
    await Promise.resolve();
  }
  const loader = harness.loader();
  if (!loader) throw new Error("summary loader never appeared");
  return loader;
}

describe("/end-review summarization loader abort (stale review-state fix)", () => {
  // Bug #16: Esc resolved the dialog ("cancelled") while navigateTree kept
  // running; a completed-after-abort navigation left the {active: true}
  // review-session entry stale, resurrecting the review widget on replay.

  const CANCELLED_MESSAGE =
    "Summarization cancelled. Use /end-review to try again.";
  const BACKGROUND_FINISHED_MESSAGE =
    "Summarization finished in the background after cancel; review ended.";

  test("abort reports cancelled, discards a completed navigation, and clears review state", async () => {
    const harness = setupEndReviewHarness({
      branchEntries: [activeReviewEntry],
    });

    const finished = harness.runEndReview();
    const loader = await waitForLoader(harness);

    pressEscape(loader); // user presses Esc on the loader
    await finished;

    expect(harness.notifications).toEqual([CANCELLED_MESSAGE]);
    expect(harness.navigateCallCount()).toBe(1);
    expect(harness.appended).toEqual([]); // nothing written while pending

    // The abandoned navigation races past the abort and completes anyway.
    harness.resolveNavigation({ cancelled: false });
    await settleMacrotask();

    // State cleared so replay can't resurrect the widget...
    expect(harness.appended).toEqual([
      { customType: REVIEW_STATE_CUSTOM_TYPE, data: { active: false } },
    ]);
    expect(harness.widgetCalls.at(-1)).toBeUndefined(); // widget removed
    // ...the user is told the review actually ended...
    expect(harness.notifications).toEqual([
      CANCELLED_MESSAGE,
      BACKGROUND_FINISHED_MESSAGE,
    ]);
    // ...and the discarded result is never applied (no follow-up drafted).
    expect(harness.editorTexts).toEqual([]);
  });

  test("abort followed by a genuinely cancelled navigation keeps the review state (retry stays valid)", async () => {
    const harness = setupEndReviewHarness({
      branchEntries: [activeReviewEntry],
    });

    const finished = harness.runEndReview();
    const loader = await waitForLoader(harness);
    pressEscape(loader);
    await finished;

    // pi stopped the navigation itself ({cancelled: true}): the tree is
    // untouched, the user is still on the review branch, so the
    // {active: true} entry must stay — clearing it would break retry.
    harness.resolveNavigation({ cancelled: true });
    await settleMacrotask();

    expect(harness.appended).toEqual([]);
    expect(harness.notifications).toEqual([CANCELLED_MESSAGE]);
  });

  test("without abort, a completed summarization still clears state and applies the result", async () => {
    const harness = setupEndReviewHarness({
      branchEntries: [activeReviewEntry],
    });

    const finished = harness.runEndReview();
    await waitForLoader(harness);
    harness.resolveNavigation({ cancelled: false });

    await finished;
    await settleMacrotask();

    expect(harness.appended).toEqual([
      { customType: REVIEW_STATE_CUSTOM_TYPE, data: { active: false } },
    ]);
    expect(harness.widgetCalls.at(-1)).toBeUndefined();
    expect(harness.notifications).toEqual([
      "Review complete! Returned and summarized.",
    ]);
    expect(harness.editorTexts).toEqual(["Act on the review findings"]);
  });
});

describe("getFinalReviewMessage (review-branch capture)", () => {
  // Fixtures run through pi's REAL SessionManager (inMemory) so
  // getBranch()'s ordering is pinned verbatim instead of re-imagined by a
  // stub. The original stub returned leaf-first arrays while pi returns
  // root-first (chronological), so this suite stayed green while
  // "Return and fix findings" always failed live ("No completed review
  // response found"): boundaryIndex landed on the shared root at index 0
  // and the scan never ran.
  const ts = (n: number) => new Date(2026, 0, 1, 0, 0, n).toISOString();
  const userEntry = (
    id: string,
    parentId: string | null,
    text: string,
    n: number,
  ) => ({
    type: "message",
    id,
    parentId,
    timestamp: ts(n),
    message: { role: "user", content: [{ type: "text", text }] },
  });
  const assistantEntry = (
    id: string,
    parentId: string,
    parts: Array<{ type: string; text?: string; thinking?: string }>,
    n: number,
  ) => ({
    type: "message",
    id,
    parentId,
    timestamp: ts(n),
    message: { role: "assistant", content: parts },
  });

  const ROOT = userEntry("root", null, "hi", 0);
  const ORIGIN = assistantEntry(
    "origin-1",
    "root",
    [{ type: "text", text: "pre-review work on the main branch" }],
    1,
  );
  const REVIEW_STATE = {
    type: "custom",
    customType: REVIEW_STATE_CUSTOM_TYPE,
    id: "rs-1",
    parentId: "root",
    timestamp: ts(2),
    data: { active: true, originId: "origin-1" },
  };
  const REVIEW_PROMPT = userEntry(
    "review-prompt",
    "rs-1",
    "Review the changes",
    3,
  );
  const REVIEW_FINAL = assistantEntry(
    "review-final",
    "review-prompt",
    [
      { type: "thinking", thinking: "internal reasoning, not the review" },
      { type: "text", text: "## Verdict\nneeds attention" },
    ],
    4,
  );
  const ABORTED_FINAL = assistantEntry(
    "aborted-final",
    "review-final",
    [{ type: "text", text: "   " }],
    5,
  );

  const ctxWith = (entries: unknown[]) =>
    ({
      sessionManager: SessionManager.inMemory("/", undefined, entries as never),
    }) as Parameters<typeof getFinalReviewMessage>[0];

  test("getBranch is root-first (chronological) — the ordering this capture depends on", () => {
    const ctx = ctxWith([
      ROOT,
      ORIGIN,
      REVIEW_STATE,
      REVIEW_PROMPT,
      REVIEW_FINAL,
    ]);
    const branch = ctx.sessionManager.getBranch();
    expect(branch[0]?.id).toBe("root");
    expect(branch[branch.length - 1]?.id).toBe("review-final"); // leaf last
  });

  test("sibling fork: returns the newest nonempty assistant text before the common ancestor", () => {
    // Review branch forks at REVIEW_STATE (under root) while the origin
    // chain runs root → origin-1 as a sibling leaf.
    const ctx = ctxWith([
      ROOT,
      ORIGIN,
      REVIEW_STATE,
      REVIEW_PROMPT,
      REVIEW_FINAL,
    ]);
    expect(getFinalReviewMessage(ctx, "origin-1")).toBe(
      "## Verdict\nneeds attention",
    );
  });

  test("origin on the leaf's own chain (fresh-session shape) is still captured", () => {
    // The live failure shape: /review in a brand-new session records an
    // origin that is an ANCESTOR of the review branch (the review forked
    // straight off it), not a sibling.
    const forkAtOrigin = {
      ...REVIEW_STATE,
      parentId: "origin-1",
    };
    const ctx = ctxWith([
      ROOT,
      ORIGIN,
      forkAtOrigin,
      REVIEW_PROMPT,
      REVIEW_FINAL,
    ]);
    expect(getFinalReviewMessage(ctx, "origin-1")).toBe(
      "## Verdict\nneeds attention",
    );
  });

  test("skips empty or thinking-only assistant messages, falling back to an older one", () => {
    const ctx = ctxWith([
      ROOT,
      ORIGIN,
      REVIEW_STATE,
      REVIEW_PROMPT,
      REVIEW_FINAL,
      ABORTED_FINAL, // newest (leaf), whitespace-only → skipped
    ]);
    expect(getFinalReviewMessage(ctx, "origin-1")).toBe(
      "## Verdict\nneeds attention",
    );
  });

  test("never reaches past the boundary into main-branch history", () => {
    // No review response on the branch (leaf is the prompt). The origin
    // chain's assistant message must not be captured — whether the origin
    // is a sibling (off the leaf path entirely) or a direct ancestor
    // (excluded by the boundary).
    const forkAtOrigin = { ...REVIEW_STATE, parentId: "origin-1" };
    expect(
      getFinalReviewMessage(
        ctxWith([ROOT, ORIGIN, REVIEW_STATE, REVIEW_PROMPT]),
        "origin-1",
      ),
    ).toBeUndefined();
    expect(
      getFinalReviewMessage(
        ctxWith([ROOT, ORIGIN, forkAtOrigin, REVIEW_PROMPT]),
        "origin-1",
      ),
    ).toBeUndefined();
  });

  test("unknown origin (empty origin path) and disjoint paths both refuse", () => {
    const ctx = ctxWith([
      ROOT,
      ORIGIN,
      REVIEW_STATE,
      REVIEW_PROMPT,
      REVIEW_FINAL,
    ]);
    // Unknown id: real sessions resolve no chain → [].
    expect(getFinalReviewMessage(ctx, "no-such-entry")).toBeUndefined();
    // Disjoint chains: an orphaned second root shares no ids with the
    // leaf path (placed first so the last entry stays the review leaf).
    const orphan = assistantEntry(
      "orphan-origin",
      null as unknown as string,
      [{ type: "text", text: "orphaned chain" }],
      9,
    );
    const disjoint = ctxWith([
      orphan,
      ROOT,
      ORIGIN,
      REVIEW_STATE,
      REVIEW_PROMPT,
      REVIEW_FINAL,
    ]);
    expect(getFinalReviewMessage(disjoint, "orphan-origin")).toBeUndefined();
  });
});

describe("/end-review fast fix path (no summarization round trip)", () => {
  const root = {
    id: "root",
    type: "message",
    message: { role: "user", content: "hi" },
  };
  const originEntry = {
    id: "origin-1",
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "pre-review work on the main branch" }],
    },
  };
  const REVIEW_TEXT =
    "## Verdict\nneeds attention\n\n- [P1] src/foo.ts:42 off-by-one";

  // Root→leaf (chronological), matching getBranch()'s real order.
  const reviewLeafEntries = [
    root,
    activeReviewEntry,
    {
      id: "review-prompt",
      type: "message",
      message: { role: "user", content: "Review the changes" },
    },
    {
      id: "review-final",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning" },
          { type: "text", text: REVIEW_TEXT },
        ],
      },
    },
  ];

  const NO_REVIEW_ERROR =
    "No completed review response found on the review branch — nothing to fix. Use /end-review → Return and summarize if you still want a branch summary.";

  test("returns instantly (summarize:false) and queues the review verbatim as the fix prompt", async () => {
    const harness = setupEndReviewHarness({
      branchEntries: reviewLeafEntries,
      originBranchEntries: [root, originEntry],
      selectChoice: "Return and fix findings",
      autoResolveNavigation: { cancelled: false },
    });

    await harness.runEndReview();

    // One navigation, no summarization LLM round trip.
    expect(harness.navigationCalls()).toEqual([
      { targetId: "origin-1", options: { summarize: false } },
    ]);
    expect(harness.loader()).toBeUndefined(); // summary loader never renders

    // The fix follow-up embeds the verbatim review.
    expect(harness.sentMessages()).toHaveLength(1);
    const sent = harness.sentMessages()[0];
    expect(sent.options).toEqual({ deliverAs: "followUp" });
    expect(sent.text).toContain("<review>");
    expect(sent.text).toContain(`</review>`);
    expect(sent.text).toContain(REVIEW_TEXT);
    expect(sent.text.indexOf(REVIEW_TEXT)).toBeGreaterThan(
      sent.text.indexOf("<review>"),
    );
    expect(sent.text).toContain("Fix in priority order");

    // State cleared, widget removed, no editor draft.
    expect(harness.appended).toEqual([
      { customType: REVIEW_STATE_CUSTOM_TYPE, data: { active: false } },
    ]);
    expect(harness.widgetCalls.at(-1)).toBeUndefined();
    expect(harness.editorTexts).toEqual([]);
    expect(harness.notifications).toEqual([
      "Review complete! Returned and queued a follow-up to fix findings.",
    ]);
  });

  test("no review response on the branch: reports and keeps the review state", async () => {
    const harness = setupEndReviewHarness({
      branchEntries: [
        root,
        activeReviewEntry,
        {
          id: "review-prompt",
          type: "message",
          message: { role: "user", content: "Review the changes" },
        },
      ],
      originBranchEntries: [root, originEntry],
      selectChoice: "Return and fix findings",
    });

    await harness.runEndReview();

    expect(harness.navigateCallCount()).toBe(0);
    expect(harness.sentMessages()).toEqual([]);
    expect(harness.appended).toEqual([]); // review stays active for retry
    expect(harness.notifications).toEqual([NO_REVIEW_ERROR]);
  });

  test("unknown origin id (empty origin path): reports instead of grabbing main-branch text", async () => {
    const harness = setupEndReviewHarness({
      branchEntries: reviewLeafEntries,
      // No originBranchEntries and "origin-1" is not on the leaf chain,
      // so getBranch("origin-1") resolves to [] like a real session.
      selectChoice: "Return and fix findings",
    });

    await harness.runEndReview();

    expect(harness.navigateCallCount()).toBe(0);
    expect(harness.sentMessages()).toEqual([]);
    expect(harness.notifications).toEqual([NO_REVIEW_ERROR]);
  });

  test("cancelled return navigation keeps the review state (retry stays valid)", async () => {
    const harness = setupEndReviewHarness({
      branchEntries: reviewLeafEntries,
      originBranchEntries: [root, originEntry],
      selectChoice: "Return and fix findings",
      autoResolveNavigation: { cancelled: true },
    });

    await harness.runEndReview();

    expect(harness.sentMessages()).toEqual([]);
    expect(harness.appended).toEqual([]);
    expect(harness.notifications).toEqual([
      "Navigation cancelled. Use /end-review to try again.",
    ]);
  });
});

describe("buildFastFixPrompt", () => {
  test("embeds the review verbatim inside delimiters, after the instructions", () => {
    const review =
      "## Verdict\nneeds attention\n\n```suggestion\n- `x: $1`\n```";
    const prompt = buildFastFixPrompt(review);

    const open = prompt.indexOf("<review>");
    const close = prompt.indexOf("</review>");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(prompt.slice(open + "<review>\n".length, close - 1)).toBe(review);
    expect(prompt).toContain("Treat the review's findings as a checklist");
  });
});
