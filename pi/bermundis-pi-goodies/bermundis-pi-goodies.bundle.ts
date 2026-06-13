// pi/bermundis-pi-goodies/copy-with-model.ts
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

// pi/bermundis-pi-goodies/name-with-ai.ts
import { Agent } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
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

// pi/bermundis-pi-goodies/notify.ts
import { execFile } from "node:child_process";
import { platform as platform2 } from "node:os";
function notifyOSC99(title, body) {
  process.stdout.write(`\x1B]99;i=1:d=1:p=${title};${body}\x1B\\`);
}
function notifyMacOS(title, body) {
  execFile("osascript", [
    "-e",
    `display notification "${body}" with title "${title}"`
  ]);
}
function notifyWindows(title, body) {
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  const script = [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`
  ].join("; ");
  execFile("powershell.exe", ["-NoProfile", "-Command", script], (err) => {
    if (err) fallback();
  });
}
function notifyLibnotify(title, body) {
  execFile("notify-send", [title, body], (err) => {
    if (err) fallback();
  });
}
function fallback() {
  process.stdout.write("\x07");
}
function notify(title, body) {
  if (process.env.WT_SESSION) {
    notifyWindows(title, body);
  } else if (platform2() === "darwin") {
    notifyMacOS(title, body);
  } else if (process.env.KITTY_WINDOW_ID) {
    notifyOSC99(title, body);
  } else if (process.env.ALACRITTY_WINDOW_ID) {
    fallback();
  } else {
    notifyLibnotify(title, body);
  }
}
function notify_default(pi) {
  pi.on("agent_end", async () => {
    notify("Pi", "Ready for input");
  });
}

// pi/bermundis-pi-goodies/zed.ts
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

// pi/bermundis-pi-goodies/index.ts
function bermundisPiGoodies(pi) {
  copy_with_model_default(pi);
  nameWithAiExtension(pi);
  notify_default(pi);
  zed_default(pi);
}
export {
  bermundisPiGoodies as default
};
