/**
 * claudish — text helpers.
 *
 * Pure functions for measuring "prose" (code stripped), splitting YAML
 * frontmatter verbatim, and checking path containment. Kept separate from the
 * extension entry point so they are easy to unit test.
 */

import { isAbsolute, relative, resolve } from "node:path";

/** A minimal view of message content blocks, enough for text extraction. */
export interface ContentBlock {
  type?: string;
  text?: string;
}

/** Extract the plain text of a message content (string or block array). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as ContentBlock;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** Remove fenced and inline code so prose length is measured without code. */
export function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Prose length of a message/file: all text with code stripped. */
export function proseLength(text: string): number {
  return stripCode(text).length;
}

/** Split a leading YAML frontmatter block off verbatim. */
export function splitFrontmatter(content: string): {
  frontmatter: string;
  body: string;
} {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!m) return { frontmatter: "", body: content };
  return { frontmatter: m[0], body: content.slice(m[0].length) };
}

/**
 * True when `file` resolves to a path at or under `dir`. Both are resolved to
 * absolute paths first, so relative and `~`-style inputs work.
 */
export function isInside(dir: string, file: string): boolean {
  const rel = relative(resolve(dir), resolve(file));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** True when a path refers to a Markdown file. */
export function isMarkdownPath(p: string): boolean {
  return p.toLowerCase().endsWith(".md");
}
