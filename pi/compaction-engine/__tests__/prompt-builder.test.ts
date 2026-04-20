import { describe, expect, it } from "bun:test";
import {
  buildPrompt,
  stripFileTags,
  computeFileLists,
  toStringArray,
  formatFileTags,
  SUMMARY_MAX_TOKENS,
} from "../prompt-builder";

// ── Tests ─────────────────────────────────────────────────────────────

describe("buildPrompt", () => {
  it("builds initial prompt with no previous summary", () => {
    const result = buildPrompt({
      transcript: "Turn 1: User asked to fix auth bug",
    });

    expect(result).toContain("<conversation>");
    expect(result).toContain("Turn 1: User asked to fix auth bug");
    expect(result).toContain("</conversation>");
    expect(result).not.toContain("<previous-summary>");
    expect(result).not.toContain("<new-work>");
  });

  it("builds update prompt with previous summary", () => {
    const result = buildPrompt({
      transcript: "Turn 2: Continued work",
      previousSummary: "## Goal\nFix the auth bug",
    });

    expect(result).toContain("<previous-summary>");
    expect(result).toContain("Fix the auth bug");
    expect(result).toContain("</previous-summary>");
    expect(result).toContain("<new-work>");
    expect(result).toContain("Turn 2: Continued work");
    expect(result).toContain("</new-work>");
    expect(result).not.toContain("<conversation>");
  });

  it("includes custom instructions in focus tag", () => {
    const result = buildPrompt({
      transcript: "Some transcript",
      customInstructions: "Focus on the auth module",
    });

    expect(result).toContain("<focus>");
    expect(result).toContain("Focus on the auth module");
    expect(result).toContain("</focus>");
  });

  it("omits focus tag when no custom instructions", () => {
    const result = buildPrompt({
      transcript: "Some transcript",
    });

    expect(result).not.toContain("<focus>");
  });

  it("omits focus tag when custom instructions are whitespace", () => {
    const result = buildPrompt({
      transcript: "Some transcript",
      customInstructions: "   \n  ",
    });

    expect(result).not.toContain("<focus>");
  });

  it("includes all three sections together", () => {
    const result = buildPrompt({
      transcript: "New work content",
      previousSummary: "Previous summary",
      customInstructions: "Custom focus",
    });

    expect(result).toContain("<focus>");
    expect(result).toContain("<previous-summary>");
    expect(result).toContain("<new-work>");
  });
});

describe("stripFileTags", () => {
  it("removes read-files and modified-files tags", () => {
    const input = `## Goal\nFix the auth bug

<read-files>
src/auth.ts
src/utils.ts
</read-files>

<modified-files>
src/auth.ts
</modified-files>

## Next Steps
1. Deploy`;

    const result = stripFileTags(input);

    expect(result).not.toContain("<read-files>");
    expect(result).not.toContain("<modified-files>");
    expect(result).not.toContain("src/auth.ts");
    expect(result).toContain("## Goal");
    expect(result).toContain("## Next Steps");
    expect(result).toContain("1. Deploy");
  });

  it("returns undefined when given undefined", () => {
    expect(stripFileTags(undefined)).toBeUndefined();
  });

  it("returns empty string when given empty string", () => {
    expect(stripFileTags("")).toBe("");
  });

  it("handles string with only tags", () => {
    const input = "<read-files>\nsrc/auth.ts\n</read-files>";
    const result = stripFileTags(input);
    expect(result).toBe("");
  });
});

describe("computeFileLists", () => {
  it("computes read and modified file lists from fileOps", () => {
    const result = computeFileLists({
      read: ["src/auth.ts", "src/utils.ts"],
      written: ["src/auth.ts"],
      edited: ["src/config.ts"],
    });

    expect(result.readFiles).toEqual(["src/utils.ts"]);
    expect(result.modifiedFiles).toEqual(["src/auth.ts", "src/config.ts"]);
  });

  it("deduplicates files", () => {
    const result = computeFileLists({
      read: ["a.ts"],
      written: ["a.ts", "a.ts"],
      edited: [],
    });

    // a.ts is both read and written, so it's only in modifiedFiles
    expect(result.readFiles).toEqual([]);
    expect(result.modifiedFiles).toEqual(["a.ts"]);
  });

  it("sorts output", () => {
    const result = computeFileLists({
      read: ["z.ts", "a.ts"],
      written: [],
      edited: ["m.ts", "b.ts"],
    });

    expect(result.readFiles).toEqual(["a.ts", "z.ts"]);
    expect(result.modifiedFiles).toEqual(["b.ts", "m.ts"]);
  });

  it("handles empty fileOps", () => {
    const result = computeFileLists({});
    expect(result.readFiles).toEqual([]);
    expect(result.modifiedFiles).toEqual([]);
  });

  it("handles undefined fileOps", () => {
    const result = computeFileLists(undefined as any);
    expect(result.readFiles).toEqual([]);
    expect(result.modifiedFiles).toEqual([]);
  });

  it("handles Set inputs", () => {
    const result = computeFileLists({
      read: new Set(["src/a.ts", "src/b.ts"]),
      written: new Set(["src/a.ts"]),
      edited: new Set(),
    });

    expect(result.readFiles).toEqual(["src/b.ts"]);
    expect(result.modifiedFiles).toEqual(["src/a.ts"]);
  });
});

describe("toStringArray", () => {
  it("converts arrays", () => {
    expect(toStringArray(["a", "b", 3, "d"])).toEqual(["a", "b", "d"]);
  });

  it("converts sets", () => {
    expect(toStringArray(new Set(["a", "b"]))).toEqual(["a", "b"]);
  });

  it("returns empty array for non-collection", () => {
    expect(toStringArray("string")).toEqual([]);
    expect(toStringArray(42)).toEqual([]);
    expect(toStringArray(null)).toEqual([]);
    expect(toStringArray(undefined)).toEqual([]);
  });
});

describe("formatFileTags", () => {
  it("formats both read and modified files", () => {
    const result = formatFileTags(
      ["src/auth.ts", "src/utils.ts"],
      ["src/auth.ts"],
    );

    expect(result).toContain("<read-files>");
    expect(result).toContain("src/auth.ts");
    expect(result).toContain("src/utils.ts");
    expect(result).toContain("</read-files>");
    expect(result).toContain("<modified-files>");
    expect(result).toContain("</modified-files>");
  });

  it("formats only read files", () => {
    const result = formatFileTags(["src/a.ts"], []);

    expect(result).toContain("<read-files>");
    expect(result).not.toContain("<modified-files>");
  });

  it("formats only modified files", () => {
    const result = formatFileTags([], ["src/a.ts"]);

    expect(result).not.toContain("<read-files>");
    expect(result).toContain("<modified-files>");
  });

  it("returns empty string for empty lists", () => {
    expect(formatFileTags([], [])).toBe("");
  });
});

describe("SUMMARY_MAX_TOKENS", () => {
  it("is 16384", () => {
    expect(SUMMARY_MAX_TOKENS).toBe(16384);
  });
});
