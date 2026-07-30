import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseCommandArguments, usePiForReview } from "./index.ts";

describe("usePiForReview", () => {
  test("routes review through the Pi ACP adapter", () => {
    expect(usePiForReview(["review", "--staged"], "/tmp/pi-acp")).toEqual([
      "review",
      "--agent-command",
      "/tmp/pi-acp",
      "--staged",
    ]);
  });

  test("leaves non-review commands unchanged", () => {
    const args = ["--staged"];
    expect(usePiForReview(args, "/tmp/pi-acp")).toBe(args);
  });

  test("honors an explicit built-in agent", () => {
    const args = ["review", "--agent", "claude"];
    expect(usePiForReview(args, "/tmp/pi-acp")).toBe(args);
  });

  test("honors an explicit custom ACP command", () => {
    const args = ["review", "--agent-command=custom-acp"];
    expect(usePiForReview(args, "/tmp/pi-acp")).toBe(args);
  });
});

describe("package integration", () => {
  test("installs the Pi ACP adapter", () => {
    expect(
      existsSync(resolve(import.meta.dir, "node_modules/.bin/pi-acp")),
    ).toBe(true);
  });

  test("installed Critique accepts generic ACP launcher options", () => {
    const result = spawnSync(
      "bun",
      [
        resolve(import.meta.dir, "node_modules/critique/src/cli.tsx"),
        "review",
        "--help",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--agent-command <executable>");
    expect(result.stdout).toContain("--agent-arg <argument>");
  });
});

describe("parseCommandArguments", () => {
  test("parses flags and refs", () => {
    expect(parseCommandArguments("--staged main HEAD")).toEqual([
      "--staged",
      "main",
      "HEAD",
    ]);
  });

  test("preserves quoted and escaped values", () => {
    expect(
      parseCommandArguments(
        String.raw`--filter "src files/**/*.ts" feature\ branch ''`,
      ),
    ).toEqual(["--filter", "src files/**/*.ts", "feature branch", ""]);
  });

  test("supports adjacent quoted fragments", () => {
    expect(parseCommandArguments(`--filter src/"foo bar"/*.ts`)).toEqual([
      "--filter",
      "src/foo bar/*.ts",
    ]);
  });

  test("rejects unterminated quotes", () => {
    expect(() => parseCommandArguments(`--filter "src/**/*.ts`)).toThrow(
      "Unterminated double quote",
    );
  });

  test("rejects a trailing escape", () => {
    expect(() => parseCommandArguments("main\\")).toThrow("Trailing escape");
  });
});
