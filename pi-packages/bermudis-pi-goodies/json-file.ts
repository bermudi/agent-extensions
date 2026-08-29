import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Combine a per-request timeout ceiling with an optional caller signal.
 * Used by every balance/model fetch so a hung endpoint can't stall the UI.
 */
export function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/**
 * Extract `text` content blocks from a message body (string or block array).
 * Returns the raw parts; callers join with the separator they need.
 */
export function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block as { type: string }).type === "text" &&
      "text" in block
    ) {
      const text = (block as { text?: string }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts;
}

/** Write JSON atomically without exposing a partially written config file. */
export function writeJsonFileAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } catch (writeError) {
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError(
          [writeError, cleanupError],
          `failed to write ${path} and clean up ${temporaryPath}`,
        );
      }
    }
    throw writeError;
  }
}

/** Delete a file if present; surface every error except an absent file. */
export function unlinkIfPresent(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
