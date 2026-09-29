import { describe, expect, test } from "bun:test";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import reviewExtension, {
  buildReviewPrompt,
  completeReviewArgument,
  parseArgs,
  parsePrReference,
  parseReviewPaths,
  tokenizeArgs,
} from "./review";

describe("/review argument completion", () => {
  test("verbs complete with trailing space only when they take a value", () => {
    expect(completeReviewArgument("")?.map((i) => i.value)).toEqual([
      "uncommitted",
      "branch ",
      "commit ",
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

  test("folder paths round-trip verbatim", async () => {
    const prompt = await buildReviewPrompt(piStub(), {
      type: "folder",
      paths: ["src/$&dir", "my $'stuff"],
    });
    expect(prompt).toContain("src/$&dir, my $'stuff");
  });
});

describe("/end-review summarization loader abort (stale review-state fix)", () => {
  // Drives the real /end-review command handler with stub pi/ctx so the
  // loader abort path in navigateWithSummary is exercised end to end.
  // Bug #16: Esc resolved the dialog ("cancelled") while navigateTree kept
  // running; a completed-after-abort navigation left the {active: true}
  // review-session entry stale, resurrecting the review widget on replay.

  const REVIEW_STATE_CUSTOM_TYPE = "review-session";
  const CANCELLED_MESSAGE =
    "Summarization cancelled. Use /end-review to try again.";
  const BACKGROUND_FINISHED_MESSAGE =
    "Summarization finished in the background after cancel; review ended.";

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

  const settleMacrotask = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 0));

  function setupEndReviewHarness(options: { branchEntries?: unknown[] } = {}) {
    // BorderedLoader's constructor reads pi's global theme (keyHint), which
    // throws "Theme not initialized" in tests unless initialized.
    initTheme();
    const branchEntries = options.branchEntries ?? [];
    const appended: Array<{ customType: string; data: unknown }> = [];
    const notifications: string[] = [];
    const widgetCalls: unknown[] = [];
    const editorTexts: string[] = [];
    const handlers = new Map<
      string,
      (args: string, ctx: ExtensionCommandContext) => Promise<void>
    >();

    let navigateCalls = 0;
    let resolveNavigation: (result: NavigateResult) => void = () => {};
    let loader: SummaryLoaderStub | undefined;

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
      ) => {
        handlers.set(name, command.handler);
      },
      appendEntry: (customType: string, data?: unknown) => {
        appended.push({ customType, data });
      },
      exec: async () => ({ stdout: "", code: 1, stderr: "" }),
      sendUserMessage: () => {},
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

    const ctx = {
      hasUI: true,
      cwd: "/",
      sessionManager: {
        getBranch: () => branchEntries,
        getEntries: () => branchEntries,
      },
      ui: {
        select: async () => "Return and summarize",
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
      navigateTree: async () => {
        navigateCalls += 1;
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
      navigateCalls: () => navigateCalls,
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

  test("abort reports cancelled, discards a completed navigation, and clears review state", async () => {
    const harness = setupEndReviewHarness({
      branchEntries: [activeReviewEntry],
    });

    const finished = harness.runEndReview();
    const loader = await waitForLoader(harness);

    pressEscape(loader); // user presses Esc on the loader
    await finished;

    expect(harness.notifications).toEqual([CANCELLED_MESSAGE]);
    expect(harness.navigateCalls()).toBe(1);
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
