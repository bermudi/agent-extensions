import { describe, expect, test } from "bun:test";
import { parsePrReference, tokenizeArgs } from "./review";

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
