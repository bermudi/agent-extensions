import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
} from "@earendil-works/pi-tui";

const commandName = "diff";

/** Complete /diff arguments: the single word "clear" (anything else the
 *  handler ignores). */
function completeDiffArguments(prefix: string): AutocompleteItem[] | null {
  const q = prefix.trim().toLowerCase();
  return "clear".startsWith(q) ? [{ value: "clear", label: "clear" }] : null;
}

/** The argument text of a /diff line, or null outside that context. */
function diffArgumentText(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): string | null {
  if (cursorLine !== 0) return null;
  const match = /^\/diff\s+(.*)$/.exec((lines[0] ?? "").slice(0, cursorCol));
  return match ? match[1] : null;
}

/**
 * Pi's editor turns Tab in slash-command argument context into a forced file
 * completion that never consults the command's getArgumentCompletions — claim
 * the /diff context and answer from its own completions (mirrors goodies'
 * wrapGoodiesAutocomplete; null falls back to file completion).
 */
function wrapDiffAutocomplete(
  current: AutocompleteProvider,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if (options.force) {
        const argumentText = diffArgumentText(lines, cursorLine, cursorCol);
        if (argumentText !== null) {
          const items = completeDiffArguments(argumentText);
          return items ? { items, prefix: argumentText } : null;
        }
      }
      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      if (diffArgumentText(lines, cursorLine, cursorCol) !== null) {
        return true;
      }
      return (
        current.shouldTriggerFileCompletion?.(
          lines,
          cursorLine,
          cursorCol,
        ) ?? true
      );
    },
  };
}

let autocompleteWrapped = false;

function getStringPath(input: unknown) {
  if (!input || typeof input !== "object" || !("path" in input))
    return undefined;
  return typeof input.path === "string" ? input.path : undefined;
}

function toAbsolute(cwd: string, filePath: string) {
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(cwd, filePath);
}

function toRelative(cwd: string, filePath: string) {
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : filePath;
}

function parseGitStatus(output: string, cwd: string) {
  const files = new Set<string>();

  for (const line of output.split("\n")) {
    if (line.length < 4) continue;

    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;

    const targetPath = rawPath.includes(" -> ")
      ? rawPath.split(" -> ").at(-1)
      : rawPath;
    if (!targetPath) continue;

    files.add(toAbsolute(cwd, targetPath.replace(/^"|"$/g, "")));
  }

  return files;
}

async function getGitChangedFiles(pi: ExtensionAPI, cwd: string) {
  const result = await pi.exec(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd, timeout: 5000 },
  );
  if (result.code !== 0) return new Set<string>();
  return parseGitStatus(result.stdout, cwd);
}

function difference(current: Set<string>, baseline: Set<string>) {
  return new Set([...current].filter((file) => !baseline.has(file)));
}

export default function (pi: ExtensionAPI) {
  let gitBaseline = new Set<string>();
  let changedFiles = new Set<string>();
  let toolTouchedFiles = new Set<string>();

  pi.on("session_start", (_event, ctx) => {
    // Claim the /diff forced-Tab context once per extension load (guarded:
    // harness stubs and limited contexts lack addAutocompleteProvider).
    const ui = (
      ctx as {
        ui?: {
          addAutocompleteProvider?: (
            factory: (
              current: AutocompleteProvider,
            ) => AutocompleteProvider,
          ) => void;
        };
      }
    ).ui;
    const add = ui?.addAutocompleteProvider;
    if (!autocompleteWrapped && typeof add === "function") {
      autocompleteWrapped = true;
      add(wrapDiffAutocomplete);
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    toolTouchedFiles = new Set();
    changedFiles = new Set();
    gitBaseline = await getGitChangedFiles(pi, ctx.cwd);
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const filePath = getStringPath(event.input);
    if (!filePath) return;

    toolTouchedFiles.add(toAbsolute(ctx.cwd, filePath));
  });

  pi.on("agent_end", async (_event, ctx) => {
    const gitChanged = await getGitChangedFiles(pi, ctx.cwd);
    changedFiles = new Set([
      ...difference(gitChanged, gitBaseline),
      ...toolTouchedFiles,
    ]);

    if (changedFiles.size > 0) {
      ctx.ui.notify(
        `${changedFiles.size} changed file(s). Run /${commandName} to view.`,
        "info",
      );
    }
  });

  pi.registerCommand(commandName, {
    description: "Show files changed by the last agent run",
    getArgumentCompletions: completeDiffArguments,
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const arg = args.trim();
      if (arg === "clear") {
        changedFiles = new Set();
        toolTouchedFiles = new Set();
        gitBaseline = await getGitChangedFiles(pi, ctx.cwd);
        ctx.ui.notify("Cleared changed file list", "info");
        return;
      }

      const files = [...changedFiles].sort((a, b) =>
        toRelative(ctx.cwd, a).localeCompare(toRelative(ctx.cwd, b)),
      );
      if (files.length === 0) {
        ctx.ui.notify(
          "No changed files tracked from the last agent run",
          "info",
        );
        return;
      }

      if (arg === "list") {
        ctx.ui.notify(
          `Changed files:\n${files.map((f) => `- ${toRelative(ctx.cwd, f)}`).join("\n")}`,
          "info",
        );
        return;
      }

      if (arg) {
        ctx.ui.notify(
          `Unknown /${commandName} argument: ${arg}. Try /${commandName}, /${commandName} list, or /${commandName} clear.`,
          "warning",
        );
        return;
      }

      const labels = files.map((f) => toRelative(ctx.cwd, f));
      const selected = await ctx.ui.select(
        "Changed files from last agent run",
        labels,
      );
      if (!selected) return;

      const selectedIndex = labels.indexOf(selected);
      const file = files[selectedIndex];
      if (!file) return;

      // Show actual git diff for the selected file
      const result = await pi.exec("git", ["diff", file], {
        cwd: ctx.cwd,
        timeout: 5000,
      });
      if (result.code === 0 && result.stdout.trim()) {
        ctx.ui.notify(`diff for ${selected}:\n${result.stdout}`, "info");
      } else {
        // File might be untracked — show a note
        ctx.ui.notify(
          `${selected} (untracked/new file — no diff available)`,
          "info",
        );
      }
    },
  });
}
