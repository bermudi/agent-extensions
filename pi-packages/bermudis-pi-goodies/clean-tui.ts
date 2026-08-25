/**
 * Collapse built-in tool output for a cleaner TUI focused on agent prose.
 *
 * Re-registers pi's built-in tools (read, bash, edit, write, find, grep, ls)
 * with the same names, delegating `execute()` to the original factory
 * implementations so behavior is unchanged. The only override is rendering:
 * each tool keeps a terse one-line call header (command, path, or pattern)
 * but produces no visible output when collapsed. Expand a row with ctrl+e or
 * click to see the full result/diff.
 *
 * This is the display target the user chose: hide output, keep the call line.
 * No global fold toggle — folding stays per-row via pi's native expand.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

type BuiltInTools = {
  read: ReturnType<typeof createReadTool>;
  bash: ReturnType<typeof createBashTool>;
  edit: ReturnType<typeof createEditTool>;
  write: ReturnType<typeof createWriteTool>;
  find: ReturnType<typeof createFindTool>;
  grep: ReturnType<typeof createGrepTool>;
  ls: ReturnType<typeof createLsTool>;
};

const toolCache = new Map<string, BuiltInTools>();

function createBuiltInTools(cwd: string): BuiltInTools {
  return {
    read: createReadTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    find: createFindTool(cwd),
    grep: createGrepTool(cwd),
    ls: createLsTool(cwd),
  };
}

function getBuiltInTools(cwd: string): BuiltInTools {
  let tools = toolCache.get(cwd);
  if (!tools) {
    tools = createBuiltInTools(cwd);
    toolCache.set(cwd, tools);
  }
  return tools;
}

function shortenPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

/** Extract the text content from a tool result, or undefined if none. */
function resultText(result: {
  content: Array<{ type: string; text?: string }>;
}): string | undefined {
  const textContent = result.content.find((c) => c.type === "text");
  return textContent?.type === "text" ? textContent.text : undefined;
}

export default function cleanTui(pi: ExtensionAPI): void {
  // parameters is a static TypeBox schema; any cwd instance yields the same
  // schema. execute() uses ctx.cwd for the real working directory.
  const schemaTools = getBuiltInTools(process.cwd());

  pi.registerTool({
    name: "read",
    label: "read",
    description: schemaTools.read.description,
    parameters: schemaTools.read.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).read.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const path = shortenPath(args.path || "");
      let display = path
        ? theme.fg("accent", path)
        : theme.fg("toolOutput", "...");
      if (args.offset !== undefined || args.limit !== undefined) {
        const start = args.offset ?? 1;
        const end = args.limit !== undefined ? start + args.limit - 1 : "";
        display += theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
      }
      return new Text(
        `${theme.fg("toolTitle", theme.bold("read"))} ${display}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      if (!expanded) return new Text("", 0, 0);
      const text = resultText(result);
      if (!text) return new Text("", 0, 0);
      return new Text(
        `\n${text
          .split("\n")
          .map((l) => theme.fg("toolOutput", l))
          .join("\n")}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: schemaTools.bash.description,
    parameters: schemaTools.bash.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).bash.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const command = args.command || "...";
      const timeout = args.timeout as number | undefined;
      const suffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
      return new Text(
        theme.fg("toolTitle", theme.bold(`$ ${command}`)) + suffix,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      if (!expanded) return new Text("", 0, 0);
      const text = resultText(result)?.trim();
      if (!text) return new Text("", 0, 0);
      return new Text(
        `\n${text
          .split("\n")
          .map((l) => theme.fg("toolOutput", l))
          .join("\n")}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "write",
    label: "write",
    description: schemaTools.write.description,
    parameters: schemaTools.write.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).write.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const path = shortenPath(args.path || "");
      const display = path
        ? theme.fg("accent", path)
        : theme.fg("toolOutput", "...");
      const lines = args.content ? args.content.split("\n").length : 0;
      const info = lines > 0 ? theme.fg("muted", ` (${lines} lines)`) : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("write"))} ${display}${info}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      if (!expanded) return new Text("", 0, 0);
      const text = resultText(result);
      if (text) return new Text(`\n${theme.fg("error", text)}`, 0, 0);
      return new Text("", 0, 0);
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: schemaTools.edit.description,
    parameters: schemaTools.edit.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).edit.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const path = shortenPath(args.path || "");
      const display = path
        ? theme.fg("accent", path)
        : theme.fg("toolOutput", "...");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("edit"))} ${display}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      if (!expanded) return new Text("", 0, 0);
      const text = resultText(result);
      if (!text) return new Text("", 0, 0);
      return new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "find",
    label: "find",
    description: schemaTools.find.description,
    parameters: schemaTools.find.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).find.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const pattern = args.pattern || "";
      const path = shortenPath(args.path || ".");
      let text = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}`;
      text += theme.fg("toolOutput", ` in ${path}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      if (!expanded) return new Text("", 0, 0);
      const text = resultText(result)?.trim();
      if (!text) return new Text("", 0, 0);
      return new Text(
        `\n${text
          .split("\n")
          .map((l) => theme.fg("toolOutput", l))
          .join("\n")}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "grep",
    label: "grep",
    description: schemaTools.grep.description,
    parameters: schemaTools.grep.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).grep.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const pattern = args.pattern || "";
      const path = shortenPath(args.path || ".");
      const glob = args.glob;
      let text = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${pattern}/`)}`;
      text += theme.fg("toolOutput", ` in ${path}`);
      if (glob) text += theme.fg("toolOutput", ` (${glob})`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      if (!expanded) return new Text("", 0, 0);
      const text = resultText(result)?.trim();
      if (!text) return new Text("", 0, 0);
      return new Text(
        `\n${text
          .split("\n")
          .map((l) => theme.fg("toolOutput", l))
          .join("\n")}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "ls",
    label: "ls",
    description: schemaTools.ls.description,
    parameters: schemaTools.ls.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).ls.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const path = shortenPath(args.path || ".");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", path)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      if (!expanded) return new Text("", 0, 0);
      const text = resultText(result)?.trim();
      if (!text) return new Text("", 0, 0);
      return new Text(
        `\n${text
          .split("\n")
          .map((l) => theme.fg("toolOutput", l))
          .join("\n")}`,
        0,
        0,
      );
    },
  });
}
