/**
 * Per-model default thinking levels — the per-model Ctrl+S that /thinking
 * lacks.
 *
 * Pi 0.84.3+'s /thinking keeps in-session changes ephemeral and Ctrl+S
 * saves only the GLOBAL default (settings.json `defaultThinkingLevel`),
 * which pi then applies on every model switch that has no entry in the
 * native `modelThinkingLevels` map — and that map is editable only
 * through the generic /settings screen. This module is the quick setter:
 *
 *   /model-thinking            save the current level as this model's default
 *   /model-thinking <level>    save (and apply now) an explicit level
 *   /model-thinking unset       drop this model's default (fall back to pi's)
 *   /model-thinking list       show every saved default
 *
 * Saved levels apply whenever the model becomes active: /model picker,
 * /model <name>, Ctrl+P cycling, and /new. keep-model-on-new composes
 * without either module knowing about the other: it restores the model
 * after /new via pi.setModel, which fires model_select, which applies the
 * saved level here.
 *
 * Priority on switch, matching pi's own: a scoped-model pin
 * (enabledModels / --models "provider/id:level") outranks the sidecar.
 * Pi applies the pin when cycling and at startup but NOT on full-picker
 * selection (setModel gets no explicit level), so the pin is applied
 * there too. Below the pin: sidecar entry, else whatever pi already
 * chose (native per-model map → global default).
 *
 * Explicit intent still wins at startup: `--thinking <level>` or
 * `--model <pattern>:<level>` suppress the sidecar for that launch.
 * Resumed and forked sessions keep the level restored from the session
 * file — pi --continue and the startup-picker resume also emit
 * session_start "startup" but carry conversation entries, which
 * distinguishes them from a fresh session — unless an explicit
 * `--model` without a :level suffix (bare name or provider/id) picked a
 * model for the resumed session, in which case that model's default
 * applies.
 *
 * Storage: ~/.pi/agent/data/bermudis-pi-goodies/thinking-levels.json —
 * the same path and shape the pre-0.7.0 model-thinking module used, so
 * its entries revive untouched. The file is read fresh on every apply,
 * so saves from other pi sessions are picked up immediately. Writes are
 * read-modify-write plus atomic rename, with no lock file: the command
 * path holds the window to ~1ms and a lost simultaneous save from
 * another pane just means re-running the command. (The old lock existed
 * for a /levels dialog that could stay open for minutes; the dialog is
 * gone.)
 *
 * Unlike the old module, nothing here listens to thinking_level_select
 * or auto-records in-session /thinking changes — every save is explicit.
 * That decision is the whole reason this is ~300 lines instead of 1156:
 * classifying pi-internal re-clamp events from user intent (branch-entry
 * reconstruction, expected-level checklists, timer races) existed only
 * to auto-persist, and it was where every historical bug lived. Pi
 * 0.84.3+'s ephemeral-by-default /thinking removed the reason to
 * auto-persist at all.
 */
import {
  getSupportedThinkingLevels,
  modelsAreEqual,
} from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionContext,
  type ExtensionEvent,
  type ExtensionAPI,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reportFailure } from "./goodies-log.ts";
import { describeError, writeJsonFileAtomic } from "./json-file.ts";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type Model = NonNullable<ExtensionContext["model"]>;
/** Not re-exported by pi-coding-agent 0.84.3's top level; derive it. */
type ModelSelectEvent = Extract<ExtensionEvent, { type: "model_select" }>;
/** Stored levels include "off", which the ExtensionAPI type omits. */
export type StoredLevel = ThinkingLevel | "off";

const THINKING_LEVEL_ORDER: readonly StoredLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_ORDER);

const DEFAULT_LEVELS_PATH = join(
  getAgentDir(),
  "data",
  "bermudis-pi-goodies",
  "thinking-levels.json",
);

export function modelKey(model: Pick<Model, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/** Validate the sidecar shape; only this module's own writer produces it. */
export function parseStoredLevels(raw: unknown): Record<string, StoredLevel> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("sidecar is not a JSON object");
  }
  const levels: Record<string, StoredLevel> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[^/]+\/.+/.test(key)) {
      throw new Error(`key ${JSON.stringify(key)} is not a provider/id pair`);
    }
    if (
      typeof value !== "string" ||
      !THINKING_LEVELS.has(value as StoredLevel)
    ) {
      throw new Error(`invalid thinking level for ${key}: ${String(value)}`);
    }
    levels[key] = value as StoredLevel;
  }
  return levels;
}

/** Read levels from disk; a corrupt sidecar degrades to empty, never crashes a switch. */
export function readStoredLevels(
  path: string = DEFAULT_LEVELS_PATH,
): Record<string, StoredLevel> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return parseStoredLevels(JSON.parse(raw));
  } catch (error) {
    reportFailure(
      "sidecar_error",
      `model-thinking: ignoring invalid ${path}: ${describeError(error)}`,
    );
    return {};
  }
}

/** Read-modify-write one key. No lock: see the module header. */
export function writeStoredLevel(
  key: string,
  level: StoredLevel | undefined,
  path: string = DEFAULT_LEVELS_PATH,
): void {
  const levels = readStoredLevels(path);
  if (level === undefined) delete levels[key];
  else levels[key] = level;
  writeJsonFileAtomic(path, levels);
}

/**
 * Mirrors pi's parseArgs semantics for the flags that express explicit
 * thinking intent: the last --model wins, --thinking counts only when its
 * value is a valid level, a trailing flag without a value token sets
 * nothing, and neither `--thinking=high` nor `--model=x` (equals form) is
 * parsed by pi at all. Flag parsing stops at `--`, exactly as pi does —
 * tokens after it are prompt text, not flags.
 */
export function explicitCliThinking(cliArgs: string[]): boolean {
  let model: string | undefined;
  let thinking: string | undefined;
  for (let index = 0; index < cliArgs.length; index++) {
    const arg = cliArgs[index];
    if (arg === "--") break;
    if (arg === "--model" && index + 1 < cliArgs.length) {
      model = cliArgs[++index];
    } else if (arg === "--thinking" && index + 1 < cliArgs.length) {
      const level = cliArgs[++index];
      if (THINKING_LEVELS.has(level)) thinking = level;
    }
  }
  if (thinking !== undefined) return true;
  if (model !== undefined) {
    const colon = model.lastIndexOf(":");
    if (
      colon > 0 &&
      THINKING_LEVELS.has(model.slice(colon + 1) as StoredLevel)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the CLI explicitly selected a model WITHOUT a :level suffix —
 * any of `--model glm`, `--model zai/glm`, or `--provider zai --model glm`.
 * That means the user chose a model for this session — even when resuming
 * via pi --continue — so the model's saved default should apply instead of
 * the resumed session's restored level. A :level suffix is thinking intent
 * and is handled by explicitCliThinking instead. The selection is never
 * compared against the active model: pi resolves patterns fuzzily, and
 * whichever model it lands on should get its own default.
 */
export function explicitCliModelSelection(cliArgs: string[]): boolean {
  let model: string | undefined;
  for (let index = 0; index < cliArgs.length; index++) {
    const arg = cliArgs[index];
    if (arg === "--") break;
    if (arg === "--model" && index + 1 < cliArgs.length) {
      model = cliArgs[++index];
    }
  }
  if (model === undefined) return false;
  const colon = model.lastIndexOf(":");
  return !(
    colon > 0 && THINKING_LEVELS.has(model.slice(colon + 1) as StoredLevel)
  );
}

/**
 * Distinguish a resumed conversation from a fresh session at startup.
 * Pi seeds every new session with an initial model_change and
 * thinking_level_change before session_start fires, so a non-empty entry
 * list is NOT evidence of a resume. A resumed session carries real
 * messages; a fresh one does not.
 */
function hasConversationEntries(
  sessionManager: ExtensionContext["sessionManager"],
): boolean {
  return sessionManager.getEntries().some((entry) => entry.type === "message");
}

function notifyContextError(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  message: string,
): void {
  // With a UI, notify() renders a persistent warning; console output
  // would only flash raw on the terminal and be wiped by the next
  // repaint. Console is the headless surface.
  if (!ctx.hasUI) console.warn(`[model-thinking] ${message}`);
  ctx.ui.notify(message, "warning");
}

/**
 * Apply the right level for the model that just became active.
 *
 * `source` is the model_select source when called from that event, or
 * undefined from session_start (startup, /new), where no model_select
 * fires. A scoped pin is applied on "set" and undefined only: pi already
 * applies it on "cycle", and "restore" is a resumed session's own state.
 */
function applyStoredLevel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  notify: boolean,
  levelsPath: string,
  source?: ModelSelectEvent["source"],
): void {
  const model = ctx.model;
  if (!model) return;

  if (source !== "restore") {
    // A scoped pin (enabledModels / --models "x:level") is pi-owned
    // per-model config and outranks the sidecar on every path. Pi applies
    // it on cycle and startup, but the full picker (setModel) and /new do
    // not carry it — apply the pin there so it holds everywhere. On cycle
    // and restore, pi (or the session's own state) already settled it.
    const scoped = ctx.scopedModels.find((entry) =>
      modelsAreEqual(entry.model, model),
    );
    if (scoped?.thinkingLevel !== undefined) {
      if (source === "set" || source === undefined) {
        setLevel(pi, ctx, scoped.thinkingLevel as StoredLevel, notify);
      }
      return;
    }
  }

  const stored = readStoredLevels(levelsPath)[modelKey(model)];
  // No entry: leave whatever pi chose (native per-model map → global
  // default → current level). The sidecar never overrides absence.
  if (stored === undefined) return;
  setLevel(pi, ctx, stored, notify);
}

function setLevel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  level: StoredLevel,
  notify: boolean,
): void {
  const before = pi.getThinkingLevel();
  // "off" is a valid runtime level; the declared API type only models
  // the non-off ladder. pi clamps to the model's capabilities.
  pi.setThinkingLevel(level as ThinkingLevel);
  const after = pi.getThinkingLevel();
  if (notify && after !== before) {
    ctx.ui.notify(`Thinking: ${before} → ${after}`, "info");
  }
}

export interface ModelThinkingOptions {
  /** Override the sidecar path (tests). */
  levelsPath?: string;
  /** Override the CLI args (tests); defaults to this process's argv. */
  cliArgs?: string[];
}

export default function modelThinking(
  pi: ExtensionAPI,
  options: ModelThinkingOptions = {},
): void {
  const levelsPath = options.levelsPath ?? DEFAULT_LEVELS_PATH;
  const cliArgs = options.cliArgs ?? process.argv.slice(2);

  pi.registerCommand("model-thinking", {
    description: "Per-model default thinking level (applied on model switch)",
    getArgumentCompletions: (prefix) => {
      // "off" already leads THINKING_LEVEL_ORDER; it is a saveable level.
      const words = ["list", "unset", ...THINKING_LEVEL_ORDER];
      const query = prefix.trim().toLowerCase();
      return words
        .filter((word) => word.startsWith(query))
        .map((word) => ({ value: word, label: word }));
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const model = ctx.model;
      if (!model) {
        notifyContextError(
          ctx,
          "No active model to save a thinking default for",
        );
        return;
      }
      const key = modelKey(model);

      if (parts[0] === "list") {
        const levels = readStoredLevels(levelsPath);
        const entries = Object.entries(levels).sort(([a], [b]) =>
          a.localeCompare(b),
        );
        if (entries.length === 0) {
          ctx.ui.notify(
            "No per-model thinking defaults saved yet — set one with /model-thinking [level]",
            "info",
          );
          return;
        }
        const lines = entries.map(
          ([entryKey, level]) =>
            `${entryKey === key ? "●" : " "} ${entryKey}: ${level}`,
        );
        ctx.ui.notify(
          `Per-model thinking defaults:\n${lines.join("\n")}`,
          "info",
        );
        return;
      }

      if (parts[0] === "unset") {
        try {
          if (readStoredLevels(levelsPath)[key] === undefined) {
            ctx.ui.notify(`No thinking default saved for ${key}`, "info");
            return;
          }
          writeStoredLevel(key, undefined, levelsPath);
        } catch (error) {
          reportFailure(
            "sidecar_error",
            `model-thinking: failed to remove ${key}: ${describeError(error)}`,
          );
          notifyContextError(
            ctx,
            `Could not remove the thinking default: ${describeError(error)}`,
          );
          return;
        }
        ctx.ui.notify(
          `${key} thinking default removed — falls back to pi's own default`,
          "info",
        );
        return;
      }

      // No argument: save the level currently in effect.
      let level: StoredLevel;
      if (parts.length === 0) {
        level = pi.getThinkingLevel();
      } else {
        const requested = parts[0].toLowerCase();
        if (!THINKING_LEVELS.has(requested)) {
          ctx.ui.notify(
            `Unknown level "${parts[0]}". Usage: /model-thinking [off|minimal|low|medium|high|xhigh|max|unset|list]`,
            "warning",
          );
          return;
        }
        const supported = getSupportedThinkingLevels(model);
        if (!supported.includes(requested as StoredLevel)) {
          ctx.ui.notify(
            `${key} does not support "${requested}". Supported: ${supported.join(", ")}`,
            "warning",
          );
          return;
        }
        level = requested as StoredLevel;
      }

      // Persist before applying: a failed write must not leave the session
      // already switched to a level that is not on disk.
      try {
        writeStoredLevel(key, level, levelsPath);
      } catch (error) {
        reportFailure(
          "sidecar_error",
          `model-thinking: failed to save ${key}: ${describeError(error)}`,
        );
        notifyContextError(
          ctx,
          `Could not save the thinking default: ${describeError(error)}`,
        );
        return;
      }
      if (parts.length > 0) setLevel(pi, ctx, level, true);
      ctx.ui.notify(`${key} thinking default: ${level}`, "info");
    },
  });

  pi.on("model_select", (event, ctx) => {
    // A restored session owns its historical thinking level.
    if (event.source === "restore") return;
    applyStoredLevel(pi, ctx, true, levelsPath, event.source);
  });

  pi.on("session_start", (event: SessionStartEvent, ctx) => {
    // Reload preserves the current session, resume/fork restore their own
    // level from the session file — none of these are ours to touch.
    if (
      event.reason === "reload" ||
      event.reason === "resume" ||
      event.reason === "fork"
    ) {
      return;
    }
    // Explicit CLI thinking intent wins for the launched session.
    if (event.reason === "startup" && explicitCliThinking(cliArgs)) return;
    // pi --continue and startup-picker resumes emit reason "startup" but
    // carry a restored conversation: keep its level, unless an explicit
    // --model (without a :level suffix) chose a model for the resumed
    // session.
    if (
      event.reason === "startup" &&
      hasConversationEntries(ctx.sessionManager) &&
      !explicitCliModelSelection(cliArgs)
    ) {
      return;
    }
    // Fresh startup and /new: snap to the model's saved default.
    applyStoredLevel(pi, ctx, event.reason === "new", levelsPath);
  });
}
