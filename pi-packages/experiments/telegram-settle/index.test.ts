import { describe, expect, test } from "bun:test";

import { BRIDGE_PIECE_LIMIT, chunkForBridge } from "./index.ts";

const LIMIT = BRIDGE_PIECE_LIMIT;

function line(n: number): string {
  return `L${n} ${"x".repeat(39)}`; // 42 chars incl. trailing newline below
}

describe("chunkForBridge", () => {
  test("short text passes through as a single chunk", () => {
    expect(chunkForBridge("hello")).toEqual(["hello"]);
  });

  test("text exactly at the limit passes through untouched", () => {
    const text = "a".repeat(LIMIT);
    expect(chunkForBridge(text)).toEqual([text]);
  });

  test("every chunk is within the limit and non-empty", () => {
    const text = Array.from({ length: 1200 }, (_, i) => line(i)).join("\n");
    const chunks = chunkForBridge(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(LIMIT);
    }
  });

  test("newline splits reassemble the original (split newline dropped)", () => {
    const text = Array.from({ length: 1200 }, (_, i) => line(i)).join("\n");
    const chunks = chunkForBridge(text);
    // Newlines every ~42 chars with limit 4096: every split window contains
    // a newline well inside the back half, so all splits are newline splits.
    expect(chunks.join("\n")).toBe(text);
  });

  test("no newlines: hard cut at the limit, exact reconstruction", () => {
    const text = "a".repeat(LIMIT * 3 + 17);
    const chunks = chunkForBridge(text);
    expect(chunks.length).toBe(4);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks.slice(0, -1)) expect(c.length).toBe(LIMIT);
    expect(chunks[chunks.length - 1].length).toBe(17);
  });

  test("newline below the half-window floor is ignored (hard cut)", () => {
    // Newline at index 100, far below the back-half floor: splitting
    // there would waste most of a piece, so the chunker hard-cuts instead.
    const text = "a".repeat(100) + "\n" + "b".repeat(LIMIT);
    const chunks = chunkForBridge(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(LIMIT);
    expect(chunks[0].endsWith("\n")).toBe(false);
    expect(chunks.join("")).toBe(text);
  });

  test("newline exactly at the last in-window position is usable", () => {
    // Newline at index LIMIT-1 (search window LIMIT-1 inclusive).
    const text = "a".repeat(LIMIT - 1) + "\n" + "b".repeat(100);
    const chunks = chunkForBridge(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(LIMIT - 1);
    expect(chunks.join("\n")).toBe(text);
  });

  test("oversized newline run terminates, never emits empty chunks, keeps content", () => {
    const text = "a".repeat(3000) + "\n".repeat(LIMIT * 4) + "b".repeat(3000);
    const chunks = chunkForBridge(text);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(LIMIT);
    }
    // Newline splits drop the boundary newline, and a run of newlines
    // drops several — so exact join(\n) reassembly does NOT hold here.
    // Non-whitespace content must survive in order, though.
    expect(chunks.map((c) => c.replace(/\n/g, "")).join("")).toBe(
      "a".repeat(3000) + "b".repeat(3000),
    );
  });

  test("newline just past the window is invisible; hard cut keeps bytes exact", () => {
    // Newline at index LIMIT (one past the LIMIT-1 search window): first
    // chunk hard-cuts at LIMIT, the lone newline then leads the next
    // window below the half-window floor, so a second hard cut follows.
    const text = "a".repeat(LIMIT) + "\n" + "b".repeat(LIMIT);
    const chunks = chunkForBridge(text);
    expect(chunks.length).toBe(3);
    expect(chunks[chunks.length - 1]).toBe("b");
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
  });

  test("argv-size safety: 200KB of text chunks below the kernel per-arg cap", () => {
    const text = "a".repeat(200_000);
    const chunks = chunkForBridge(text);
    expect(chunks.length).toBe(Math.ceil(200_000 / LIMIT));
    for (const c of chunks) expect(c.length).toBeLessThan(128 * 1024);
  });

  test("piece limit is rich-bubble sized: under sendRichMessage's 32768", () => {
    expect(BRIDGE_PIECE_LIMIT).toBe(32_000);
    expect(BRIDGE_PIECE_LIMIT).toBeLessThan(32_768);
    // and far under the kernel's per-argv-string cap (128KB)
    expect(BRIDGE_PIECE_LIMIT).toBeLessThan(128 * 1024);
  });
});
