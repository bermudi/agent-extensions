export const SUMMARY_MAX_TOKENS = 16384;

export function buildPrompt(args: { transcript: string; previousSummary?: string; customInstructions?: string }) {
  const parts: string[] = [];

  if (args.customInstructions?.trim()) {
    parts.push(`<focus>\n${args.customInstructions.trim()}\n</focus>`);
  }

  if (args.previousSummary?.trim()) {
    parts.push(`<previous-summary>\n${args.previousSummary.trim()}\n</previous-summary>`);
    parts.push(`<new-work>\n${args.transcript}\n</new-work>`);
  } else {
    parts.push(`<conversation>\n${args.transcript}\n</conversation>`);
  }

  return parts.join("\n\n");
}

export function stripFileTags(summary?: string) {
  if (!summary) return summary;
  return summary
    .replace(/\n?<read-files>[\s\S]*?<\/read-files>/g, "")
    .replace(/\n?<modified-files>[\s\S]*?<\/modified-files>/g, "")
    .trim();
}

export function computeFileLists(fileOps: Record<string, any>) {
  const read = toStringArray(fileOps?.read);
  const written = toStringArray(fileOps?.written);
  const edited = toStringArray(fileOps?.edited);

  const modifiedSet = new Set([...written, ...edited]);
  const readFiles = [...new Set(read.filter((path) => !modifiedSet.has(path)))].sort();
  const modifiedFiles = [...modifiedSet].sort();

  return { readFiles, modifiedFiles };
}

export function toStringArray(value: unknown) {
  if (value instanceof Set) {
    return [...value].filter((item): item is string => typeof item === "string");
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

export function formatFileTags(readFiles: string[], modifiedFiles: string[]) {
  const parts: string[] = [];

  if (readFiles.length > 0) {
    parts.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }

  if (modifiedFiles.length > 0) {
    parts.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }

  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}
