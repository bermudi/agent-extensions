// @ts-nocheck

// copy-with-model.ts
import { execSync, spawn } from "node:child_process";
import { platform } from "node:os";
function copyToClipboard(text) {
  const p = platform();
  try {
    if (p === "darwin") {
      execSync("pbcopy", { input: text, timeout: 5e3 });
      return;
    }
    if (p === "win32") {
      execSync("clip", { input: text, timeout: 5e3 });
      return;
    }
    if (process.env.WAYLAND_DISPLAY) {
      const proc = spawn("wl-copy", [], {
        stdio: ["pipe", "ignore", "ignore"]
      });
      proc.stdin.on("error", () => {
      });
      proc.stdin.write(text);
      proc.stdin.end();
      proc.unref();
      return;
    }
    if (process.env.DISPLAY) {
      try {
        execSync("xclip -selection clipboard", { input: text, timeout: 5e3 });
      } catch {
        execSync("xsel --clipboard --input", { input: text, timeout: 5e3 });
      }
      return;
    }
  } catch {
    const encoded = Buffer.from(text).toString("base64");
    if (encoded.length <= 1e5) {
      process.stdout.write(`\x1B]52;c;${encoded}\x07`);
      return;
    }
  }
  throw new Error("No clipboard available");
}
function getLastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant") continue;
    if (msg.stopReason === "aborted" && (!msg.content || msg.content.length === 0))
      continue;
    let text = "";
    for (const block of msg.content ?? []) {
      if (block.type === "text") text += block.text;
    }
    return text.trim() || void 0;
  }
  return void 0;
}
function modelTag(model) {
  return model.id;
}
function wrapInCodeBlock(tag, text) {
  let maxRun = 0;
  for (const line of text.split("\n")) {
    let run = 0;
    for (const ch of line) {
      if (ch === "`") {
        run++;
        maxRun = Math.max(maxRun, run);
      } else {
        run = 0;
      }
    }
  }
  const fenceLen = Math.max(3, maxRun + 1);
  const fence = "`".repeat(fenceLen);
  return `${fence}${tag}
${text}
${fence}`;
}
function copy_with_model_default(pi) {
  pi.registerCommand("copy-with-model", {
    description: "Copy last assistant message to clipboard in a code block tagged with the model name",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const entries = ctx.sessionManager.getEntries();
      const text = getLastAssistantText(entries);
      if (!text) {
        ctx.ui.notify("No assistant messages to copy", "error");
        return;
      }
      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }
      const tag = modelTag(model);
      const wrapped = wrapInCodeBlock(tag, text);
      try {
        copyToClipboard(wrapped);
        ctx.ui.notify(`Copied with model \`${tag}\``, "info");
      } catch (err) {
        ctx.ui.notify(
          `Failed to copy: ${err instanceof Error ? err.message : err}`,
          "error"
        );
      }
    }
  });
}

// name-with-ai.ts
import { Agent } from "@earendil-works/pi-agent-core";
import {
  streamSimple
} from "@earendil-works/pi-ai/compat";
import {
  convertToLlm
} from "@earendil-works/pi-coding-agent";
var NAMING_PROMPT = [
  "You are a session naming engine. Given a user's message, produce a short, descriptive session name.",
  "",
  "Rules:",
  "- Maximum 60 characters.",
  "- No quotes, no markdown, no punctuation at the end.",
  '- Use imperative or noun-phrase style (e.g. "Refactor auth middleware", "Fix CSS grid layout").',
  '- Be specific, not generic. "Add retry logic to fetch helper" > "Code changes".',
  "- Output ONLY the name. Nothing else."
].join("\n");
function extractLastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const parts = [];
      for (const block of msg.content) {
        if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block)
          parts.push(block.text ?? "");
      }
      return parts.join("\n").trim();
    }
  }
  return "";
}
function extractText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(
      (b) => typeof b === "object" && b !== null
    ).map((b) => b.type === "text" ? b.text ?? "" : "").filter(Boolean).join("\n");
  }
  return "";
}
function sanitizeName(raw) {
  return raw.replace(/^["'`]+|["'`]+$/g, "").replace(/^\*+|\*+$/g, "").replace(/^#+\s*/, "").replace(/[.!?:;]+$/, "").replace(/\n/g, " ").trim().slice(0, 60);
}
function nameWithAiExtension(pi) {
  pi.registerCommand("name-with-ai", {
    description: "Generate a session name using AI from the first user message",
    handler: async (args, ctx) => {
      const manual = args?.trim();
      if (manual) {
        pi.setSessionName(manual);
        ctx.ui.notify(`Session named: ${manual}`, "info");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model selected \u2014 switch to a model first", "warning");
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const firstUser = branch.find(
        (e) => e.type === "message" && e.message?.role === "user"
      );
      if (!firstUser || firstUser.type !== "message") {
        ctx.ui.notify("Nothing to name yet \u2014 send a message first", "warning");
        return;
      }
      const msgContent = firstUser.message.content;
      const prompt = extractText(msgContent);
      if (!prompt) {
        ctx.ui.notify(
          "First message is empty \u2014 can't generate a name",
          "warning"
        );
        return;
      }
      const snippet = prompt.length > 1e3 ? prompt.slice(0, 997) + "\u2026" : prompt;
      ctx.ui.setStatus("name-with-ai", "Generating name\u2026");
      const abortController = new AbortController();
      const onCtxAbort = () => abortController.abort();
      if (ctx.signal)
        ctx.signal.addEventListener("abort", onCtxAbort, { once: true });
      try {
        const model = ctx.model;
        const agent = new Agent({
          initialState: {
            systemPrompt: NAMING_PROMPT,
            model,
            thinkingLevel: "off",
            messages: []
          },
          convertToLlm,
          streamFn: async (m, context, options) => {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
            if (!auth.ok)
              throw new Error(
                `Auth failed: ${auth.error}`
              );
            return streamSimple(m, context, {
              ...options,
              apiKey: auth.apiKey,
              headers: auth.headers ?? void 0
            });
          }
        });
        if (abortController.signal.aborted) return;
        const abortHandler = () => {
          try {
            agent.abort();
          } catch {
          }
        };
        abortController.signal.addEventListener("abort", abortHandler, {
          once: true
        });
        await agent.prompt(snippet);
        await agent.waitForIdle();
        const output = extractLastAssistantText(agent.state.messages);
        const name = sanitizeName(output);
        if (name) {
          pi.setSessionName(name);
          ctx.ui.notify(`Named: ${name}`, "info");
        } else {
          ctx.ui.notify(
            "AI returned an empty name \u2014 try /name-with-ai <name>",
            "warning"
          );
        }
        abortController.signal.removeEventListener("abort", abortHandler);
      } catch (err) {
        ctx.ui.notify(
          `Naming failed: ${err instanceof Error ? err.message : String(err)}`,
          "error"
        );
      } finally {
        if (ctx.signal) ctx.signal.removeEventListener("abort", onCtxAbort);
        ctx.ui.setStatus("name-with-ai", void 0);
      }
    }
  });
}

// zed.ts
import { spawn as spawn2 } from "node:child_process";
function zed_default(pi) {
  const zedBin = process.platform === "linux" ? "zeditor" : "zed";
  pi.registerCommand("z", {
    description: "Open Zed editor on cwd (new window)",
    handler: async (_args, ctx) => {
      const child = spawn2(zedBin, ["--new", ctx.cwd], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      ctx.ui.notify(`Opening Zed: ${ctx.cwd}`, "info");
    }
  });
}

// prefer-tools.ts
import {
  isToolCallEventType
} from "@earendil-works/pi-coding-agent";
var RULES = [
  {
    names: ["rm"],
    reason: "rm is blocked \u2014 use `trash` instead (recoverable beats gone)"
  },
  {
    names: ["python", "python3", "pip", "pip3", "pytest", "mypy"],
    reason: "bare python/pip/pytest/mypy are blocked \u2014 use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)"
  }
];
var COMMAND_PREFIX_KEYWORDS = /* @__PURE__ */ new Set([
  "if",
  "while",
  "until",
  "then",
  "else",
  "elif",
  "do",
  "time",
  "!"
]);
var WORD_STOP = " 	\n\r|&;<>()\"'`$";
function matchCommand(name) {
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  for (const rule of RULES) {
    if (rule.names.includes(base)) return rule.reason;
  }
  return void 0;
}
function readWord(s, i) {
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "	" || c === "\n" || c === "\r") break;
    if (c === "\\" && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (WORD_STOP.includes(c)) break;
    i++;
  }
  return { word: s.slice(start, i), next: i };
}
function readQuote(s, i, quote, escape) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (escape && c === "\\" && j + 1 < s.length) {
      j += 2;
      continue;
    }
    if (c === quote) {
      j++;
      break;
    }
    j++;
  }
  return j;
}
function skipBalancedParens(s, i, openLen) {
  let depth = openLen === 3 ? 2 : 1;
  let j = i + openLen;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "'") {
      j = readQuote(s, j, "'", false);
      continue;
    }
    if (c === '"') {
      j = readQuote(s, j, '"', true);
      continue;
    }
    if (c === "`") {
      j = readQuote(s, j, "`", true);
      continue;
    }
    if (c === "$" && s.startsWith("$(", j)) {
      j++;
      continue;
    }
    if (c === "(") {
      depth++;
      j++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) return j + 1;
      j++;
      continue;
    }
    j++;
  }
  return s.length;
}
function skipBalancedBraces(s, i) {
  let depth = 1;
  let j = i + 2;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "'") {
      j = readQuote(s, j, "'", false);
      continue;
    }
    if (c === '"') {
      j = readQuote(s, j, '"', true);
      continue;
    }
    if (c === "`") {
      j = readQuote(s, j, "`", true);
      continue;
    }
    if (c === "$" && s.startsWith("$(", j)) {
      j++;
      continue;
    }
    if (c === "{") {
      depth++;
      j++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0) return j + 1;
      j++;
      continue;
    }
    j++;
  }
  return s.length;
}
function readDollar(s, i) {
  if (i >= s.length || s[i] !== "$") return null;
  if (s.startsWith("$'", i)) {
    return { next: readQuote(s, i + 1, "'", true) };
  }
  if (s.startsWith("((", i + 1)) {
    return { next: skipBalancedParens(s, i, 3) };
  }
  if (s.startsWith("(", i + 1)) {
    const end = skipBalancedParens(s, i, 2);
    const closeParen = end > 0 && s[end - 1] === ")" ? 1 : 0;
    const inner = s.slice(i + 2, end - closeParen);
    const reason = detectLegacyTool(inner);
    return { next: end, reason };
  }
  if (s.startsWith("{", i + 1)) {
    return { next: skipBalancedBraces(s, i) };
  }
  if (i + 1 < s.length && /[0-9?@*#\-!$]/.test(s[i + 1])) {
    return { next: i + 2 };
  }
  let j = i + 1;
  while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
  return { next: j };
}
function readOperator(s, i) {
  const c = s[i];
  if (c === "<") {
    if (s.startsWith("<<-", i))
      return { type: "heredoc", next: i + 3, indented: true };
    if (s.startsWith("<<<", i)) return { type: "redirect", next: i + 3 };
    if (s.startsWith("<<", i))
      return { type: "heredoc", next: i + 2, indented: false };
    if (s.startsWith("<>", i) || s.startsWith("<&", i))
      return { type: "redirect", next: i + 2 };
    return { type: "redirect", next: i + 1 };
  }
  if (c === ">") {
    if (s.startsWith(">>", i)) return { type: "redirect", next: i + 2 };
    if (s.startsWith(">&", i)) return { type: "redirect", next: i + 2 };
    return { type: "redirect", next: i + 1 };
  }
  if (c === "&") {
    if (s.startsWith("&>>", i)) return { type: "redirect", next: i + 3 };
    if (s.startsWith("&&", i)) return { type: "separator", next: i + 2 };
    if (s.startsWith("&>", i)) return { type: "redirect", next: i + 2 };
    return { type: "separator", next: i + 1 };
  }
  if (c === "|") {
    if (s.startsWith("||", i)) return { type: "separator", next: i + 2 };
    if (s.startsWith("|&", i)) return { type: "separator", next: i + 2 };
    return { type: "separator", next: i + 1 };
  }
  if (c === ";") {
    if (s.startsWith(";;", i)) return { type: "separator", next: i + 2 };
    if (s.startsWith(";&", i)) return { type: "separator", next: i + 2 };
    return { type: "separator", next: i + 1 };
  }
  if (c === "(" || c === ")") return { type: "separator", next: i + 1 };
  return null;
}
function readHeredocDelimiter(s, i) {
  while (i < s.length && (s[i] === " " || s[i] === "	")) i++;
  if (i >= s.length) return null;
  const c = s[i];
  if (c === "'" || c === '"') {
    const end = readQuote(s, i, c, c === '"');
    return { delimiter: s.slice(i + 1, end - 1), next: end };
  }
  const { word, next } = readWord(s, i);
  if (word.length === 0) return null;
  return { delimiter: word, next };
}
function skipHeredocBody(s, i, delimiter, indented) {
  let pos = i;
  while (pos <= s.length) {
    const nl = s.indexOf("\n", pos);
    const end = nl === -1 ? s.length : nl;
    let line = s.slice(pos, end);
    if (indented) line = line.replace(/^\t+/, "");
    if (line === delimiter) {
      return nl === -1 ? s.length : nl + 1;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return s.length;
}
function detectLegacyTool(command) {
  let i = 0;
  let commandPos = true;
  let sudoNext = false;
  let redirectTarget = false;
  let heredoc = null;
  while (i < command.length) {
    if (heredoc && !heredoc.pending) {
      i = skipHeredocBody(command, i, heredoc.delimiter, heredoc.indented);
      heredoc = null;
      commandPos = true;
      redirectTarget = false;
      sudoNext = false;
      continue;
    }
    const c = command[i];
    if (c === " " || c === "	" || c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      if (heredoc?.pending) {
        heredoc.pending = false;
      } else {
        commandPos = true;
      }
      redirectTarget = false;
      sudoNext = false;
      i++;
      continue;
    }
    if (c === "#") {
      const nl = command.indexOf("\n", i);
      if (nl === -1) break;
      if (heredoc?.pending) heredoc.pending = false;
      i = nl + 1;
      commandPos = true;
      redirectTarget = false;
      sudoNext = false;
      continue;
    }
    const op = readOperator(command, i);
    if (op) {
      i = op.next;
      if (op.type === "separator") {
        commandPos = true;
        redirectTarget = false;
        sudoNext = false;
      } else if (op.type === "redirect") {
        redirectTarget = true;
        sudoNext = false;
      } else if (op.type === "heredoc") {
        const delim = readHeredocDelimiter(command, i);
        if (!delim) break;
        heredoc = {
          delimiter: delim.delimiter,
          indented: op.indented,
          pending: true
        };
        i = delim.next;
        commandPos = false;
        redirectTarget = false;
        sudoNext = false;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i = readQuote(command, i, quote, quote !== "'");
      if (redirectTarget) redirectTarget = false;
      if (sudoNext) sudoNext = false;
      if (commandPos) commandPos = false;
      continue;
    }
    if (c === "$") {
      const d = readDollar(command, i);
      if (d) {
        if (d.reason) return d.reason;
        i = d.next;
        if (redirectTarget) redirectTarget = false;
        if (sudoNext) sudoNext = false;
        if (commandPos) commandPos = false;
      } else {
        i++;
      }
      continue;
    }
    const { word, next } = readWord(command, i);
    if (word.length === 0) {
      i = next;
      continue;
    }
    i = next;
    if (redirectTarget) {
      redirectTarget = false;
      commandPos = false;
      continue;
    }
    if (commandPos) {
      if (word === "sudo") {
        sudoNext = true;
        continue;
      }
      if (sudoNext) {
        if (word.startsWith("-")) continue;
        const reason = matchCommand(word);
        if (reason) return reason;
        sudoNext = false;
      } else {
        const reason = matchCommand(word);
        if (reason) return reason;
      }
      if (!COMMAND_PREFIX_KEYWORDS.has(word)) {
        commandPos = false;
      }
    } else {
      commandPos = false;
    }
  }
  return void 0;
}
function preferTools(pi) {
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return;
    const reason = detectLegacyTool(event.input.command ?? "");
    if (reason) {
      return { block: true, reason };
    }
  });
}

// index.ts
function bermudisPiGoodies(pi) {
  copy_with_model_default(pi);
  nameWithAiExtension(pi);
  zed_default(pi);
  preferTools(pi);
}
export {
  bermudisPiGoodies as default
};
