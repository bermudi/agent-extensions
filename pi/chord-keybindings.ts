import { basename } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { CustomEditor, SessionManager, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const COMMAND_MODEL = "chord:model";
const COMMAND_RESUME = "chord:resume";
const COMMAND_NEW = "chord:new";

function currentModelId(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  return model ? `${model.provider}/${model.id}` : undefined;
}

function sortModels(a: Model<any>, b: Model<any>, current?: string): number {
  const aId = `${a.provider}/${a.id}`;
  const bId = `${b.provider}/${b.id}`;
  const aCurrent = aId === current ? 0 : 1;
  const bCurrent = bId === current ? 0 : 1;
  if (aCurrent !== bCurrent) return aCurrent - bCurrent;

  const providerCmp = a.provider.localeCompare(b.provider);
  if (providerCmp !== 0) return providerCmp;

  const nameCmp = (a.name ?? a.id).localeCompare(b.name ?? b.id);
  if (nameCmp !== 0) return nameCmp;

  return a.id.localeCompare(b.id);
}

function shorten(text: string | undefined, max = 56): string {
  if (!text) return "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

class ChordEditor extends CustomEditor {
  private prefixActive = false;

  private trigger(action: "app.model.select" | "app.session.resume" | "app.session.new"): void {
    this.prefixActive = false;
    this.actionHandlers.get(action)?.();
  }

  handleInput(data: string): void {
    if (this.prefixActive) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("g")) || matchesKey(data, Key.ctrl("c"))) {
        this.prefixActive = false;
        return;
      }

      const key = data.length === 1 ? data.toLowerCase() : "";
      if (key === "m") {
        this.trigger("app.model.select");
        return;
      }
      if (key === "l") {
        this.trigger("app.session.resume");
        return;
      }
      if (key === "n") {
        this.trigger("app.session.new");
        return;
      }
      if (key === "r") {
        this.prefixActive = false;
        this.setText("/reload");
        this.onSubmit?.("/reload");
        return;
      }

      this.prefixActive = false;
      return;
    }

    if (matchesKey(data, Key.ctrl("x"))) {
      this.prefixActive = true;
      return;
    }

    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!this.prefixActive || lines.length === 0) return lines;

    const label = " C-x (M/L/N/R) ";
    const last = lines.length - 1;
    if (visibleWidth(lines[last]!) >= label.length) {
      lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
    }
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new ChordEditor(tui, theme, keybindings));
  });

  pi.registerCommand(COMMAND_MODEL, {
    description: "Open model picker (Ctrl+X M)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      ctx.modelRegistry.refresh();
      const current = currentModelId(ctx);
      const models = ctx.modelRegistry.getAvailable().sort((a, b) => sortModels(a, b, current));

      if (models.length === 0) {
        ctx.ui.notify("No models with configured auth are available", "warning");
        return;
      }

      const labels = models.map((model) => {
        const id = `${model.provider}/${model.id}`;
        const currentTag = id === current ? " [current]" : "";
        const name = model.name && model.name !== model.id ? ` — ${model.name}` : "";
        return `${id}${currentTag}${name}`;
      });
      const byLabel = new Map(labels.map((label, index) => [label, models[index]!]));

      const selected = await ctx.ui.select("Select model", labels);
      if (!selected) return;

      const model = byLabel.get(selected);
      if (!model) return;

      const ok = await pi.setModel(model);
      if (!ok) {
        ctx.ui.notify(`No API key available for ${model.provider}/${model.id}`, "error");
        return;
      }

      ctx.ui.notify(`Model set to ${model.provider}/${model.id}`, "success");
    },
  });

  pi.registerCommand(COMMAND_RESUME, {
    description: "Open session picker (Ctrl+X L)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const currentPath = ctx.sessionManager.getSessionFile();
      const sessions = (await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir()))
        .filter((session) => session.path !== currentPath)
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());

      if (sessions.length === 0) {
        ctx.ui.notify("No other sessions found", "info");
        return;
      }

      const labels = sessions.map((session) => {
        const stamp = session.modified.toLocaleString();
        const title = session.name?.trim() || shorten(session.firstMessage, 48) || basename(session.path);
        const preview = shorten(session.firstMessage, 56);
        return preview && preview !== title
          ? `${stamp} — ${title} — ${preview}`
          : `${stamp} — ${title}`;
      });
      const byLabel = new Map(labels.map((label, index) => [label, sessions[index]!]));

      const selected = await ctx.ui.select("Resume session", labels);
      if (!selected) return;

      const session = byLabel.get(selected);
      if (!session) return;

      await ctx.switchSession(session.path);
    },
  });

  pi.registerCommand(COMMAND_NEW, {
    description: "Create a new session (Ctrl+X N)",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });
}
