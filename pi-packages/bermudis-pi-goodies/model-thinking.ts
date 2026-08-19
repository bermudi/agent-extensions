/**
 * Per-model thinking levels, stored in an extension-owned sidecar file.
 *
 * Pi's native home for this is the `enabledModels` scoped-models config
 * ("zai/glm-5.3:high"), but pi's /scoped-models screen rewrites
 * enabledModels with bare model ids, destroying any :level suffix on every
 * save. Rather than fight that writer, levels live in a sidecar keyed by
 * provider/id:
 *
 *   ~/.pi/agent/data/bermudis-pi-goodies/thinking-levels.json
 *
 * /scoped-models keeps owning which models are enabled and their cycle
 * order; /levels (registered here) owns the per-model thinking level; the
 * hooks below apply the stored level whenever a model becomes active:
 * full-picker selection, Ctrl+P cycling, startup, and /new (which pi
 * starts on the saved default model).
 *
 * Explicit CLI intent still wins at startup: `--thinking <level>` or
 * `--model <pattern>:<level>` suppress the stored level for that session.
 * A model whose registered id genuinely ends in ":<level>" is
 * indistinguishable from thinking shorthand without the registry; such a
 * model opts out of its stored level for that startup — switch or cycle
 * to re-apply, or use --thinking explicitly.
 *
 * Resumed and forked sessions keep the level restored by pi (model_select
 * with source "restore" is ignored). Pi emits model_select only when the
 * model actually changes, so re-selecting the already-active model in the
 * full picker fires no event and its stored level cannot re-apply there.
 */
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  getAgentDir,
  keyText,
  Theme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Spacer,
  Text,
  getKeybindings,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFileAtomic } from "./json-file.ts";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type Model = NonNullable<ExtensionContext["model"]>;
/** Stored levels include "off", which the ExtensionAPI type omits. */
type StoredLevel = ThinkingLevel | "off";

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

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
    if (!key.includes("/")) {
      throw new Error(`key ${JSON.stringify(key)} is not a provider/id pair`);
    }
    if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
      throw new Error(`invalid thinking level for ${key}: ${String(value)}`);
    }
    levels[key] = value as StoredLevel;
  }
  return levels;
}

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
    // A corrupt sidecar must not take the session down; re-save from /levels.
    console.error(`[model-thinking] ignoring invalid ${path}:`, error);
    return {};
  }
}

export function writeStoredLevels(
  levels: Record<string, StoredLevel>,
  path: string = DEFAULT_LEVELS_PATH,
): void {
  writeJsonFileAtomic(path, levels);
}

/** The level ladder a row can cycle through: inherit + the model's levels. */
export function buildLadder(model: Model): (StoredLevel | undefined)[] {
  return [undefined, ...getSupportedThinkingLevels(model)];
}

/**
 * Step a row's value through its ladder. A current value outside the
 * ladder (e.g. a stored level the model no longer supports) snaps to
 * inherit from either direction rather than jumping to an arbitrary rung.
 */
export function cycleLevel(
  ladder: readonly (StoredLevel | undefined)[],
  current: StoredLevel | undefined,
  delta: number,
): StoredLevel | undefined {
  let index = ladder.indexOf(current);
  if (index === -1) index = delta > 0 ? -1 : 1;
  index = (index + delta + ladder.length) % ladder.length;
  return ladder[index];
}

/**
 * Collect the saveable map: explicit levels for shown rows, minus every
 * row left on inherit. Stored keys with no row (models no longer scoped)
 * survive untouched — that is what makes levels outlive /scoped-models.
 */
export function collectLevels(
  values: Readonly<Record<string, StoredLevel | undefined>>,
  rows: readonly { key: string }[],
): Record<string, StoredLevel> {
  const result: Record<string, StoredLevel | undefined> = { ...values };
  for (const row of rows) {
    if (result[row.key] === undefined) delete result[row.key];
  }
  return result as Record<string, StoredLevel>;
}

/**
 * Mirrors Pi's parseArgs semantics for the two flags that express explicit
 * thinking intent: the last --model wins, --thinking counts only when its
 * value is a valid level, and a trailing flag without a value token sets
 * nothing. Degenerate argv where another flag consumes a bare
 * "--model"/"--thinking" as its value is not mirrored.
 */
function explicitCliThinking(): boolean {
  const args = process.argv.slice(2);
  let model: string | undefined;
  let thinking: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--model" && index + 1 < args.length) {
      model = args[++index];
    } else if (arg === "--thinking" && index + 1 < args.length) {
      const level = args[++index];
      if (THINKING_LEVELS.has(level)) thinking = level;
    }
  }
  if (thinking !== undefined) return true;
  if (model !== undefined) {
    const colon = model.lastIndexOf(":");
    if (colon > 0 && THINKING_LEVELS.has(model.slice(colon + 1))) return true;
  }
  return false;
}

function sameModel(
  left: Pick<Model, "provider" | "id">,
  right: Pick<Model, "provider" | "id">,
): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function applyStoredLevel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  notify: boolean,
  levelsPath: string,
): void {
  const model = ctx.model;
  if (!model) return;
  // A native scoped level for this session (via --models "x:level" or a
  // hand-suffixed enabledModels entry) is pi-owned state; the sidecar only
  // fills in where pi has no level, never overrides one.
  const scoped = ctx.scopedModels.find((entry) =>
    sameModel(entry.model, model),
  );
  if (scoped?.thinkingLevel !== undefined) return;

  const level = readStoredLevels(levelsPath)[modelKey(model)];
  if (level === undefined) return;

  const before = pi.getThinkingLevel();
  // "off" is a valid runtime level (pi clamps per model); the declared API
  // type only models the non-off ladder.
  pi.setThinkingLevel(level as ThinkingLevel);
  if (notify && pi.getThinkingLevel() !== before) {
    ctx.ui.notify(`Thinking: ${before} → ${pi.getThinkingLevel()}`, "info");
  }
}

/** A keybinding hint formatted with the injected theme, not the global one. */
function hint(theme: Theme, keys: string, description: string): string {
  return theme.fg("dim", keys) + theme.fg("muted", ` ${description}`);
}

interface LevelsRow {
  key: string;
  ladder: (StoredLevel | undefined)[];
}

export class LevelsSelectorComponent extends Container {
  private selectedIndex = 0;
  private readonly listContainer = new Container();
  private closed = false;

  constructor(
    title: string,
    private readonly rows: LevelsRow[],
    private readonly activeKey: string | undefined,
    private readonly values: Record<string, StoredLevel | undefined>,
    private readonly theme: Theme,
    private readonly done: (
      result: Record<string, StoredLevel> | undefined,
    ) => void,
  ) {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        theme.fg("muted", "inherit = follow pi's global default level"),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        hint(this.theme, "↑↓", "navigate") +
          "  " +
          hint(this.theme, "←→", "cycle level") +
          "  " +
          hint(this.theme, keyText("tui.select.confirm"), "save") +
          "  " +
          hint(this.theme, keyText("tui.select.cancel"), "cancel"),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.updateList();
  }

  private levelLabel(key: string): string {
    return this.values[key] ?? "inherit";
  }

  private updateList(): void {
    this.listContainer.clear();
    const width = Math.max(...this.rows.map((row) => row.key.length));
    for (const [index, row] of this.rows.entries()) {
      const selected = index === this.selectedIndex;
      const marker =
        row.key === this.activeKey
          ? this.theme.fg("accent", "● ")
          : this.theme.fg("muted", "  ");
      const level = this.levelLabel(row.key);
      const levelText =
        level === "inherit"
          ? this.theme.fg("muted", level)
          : this.theme.fg("accent", level);
      const line = `${marker}${row.key.padEnd(width)}  ${levelText}`;
      this.listContainer.addChild(
        new Text(
          selected ? this.theme.fg("accent", `→ ${line}`) : `  ${line}`,
          1,
          0,
        ),
      );
    }
  }

  private cycle(delta: number): void {
    const row = this.rows[this.selectedIndex];
    if (!row) return;
    this.values[row.key] = cycleLevel(row.ladder, this.values[row.key], delta);
    this.updateList();
  }

  private collect(): Record<string, StoredLevel> {
    return collectLevels(this.values, this.rows);
  }

  private finish(result: Record<string, StoredLevel> | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.done(result);
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.updateList();
    } else if (kb.matches(data, "tui.select.down") || data === "j") {
      this.selectedIndex = Math.min(
        this.rows.length - 1,
        this.selectedIndex + 1,
      );
      this.updateList();
    } else if (
      kb.matches(data, "tui.select.confirm") ||
      data === "\n" ||
      data === "\r"
    ) {
      this.finish(this.collect());
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.finish(undefined);
    } else if (data === "\x1b[D" || data === "h") {
      this.cycle(-1);
    } else if (data === "\x1b[C" || data === "l") {
      this.cycle(1);
    }
  }
}

export interface ModelThinkingOptions {
  /** Override the sidecar path (tests). */
  levelsPath?: string;
}

export default function modelThinking(
  pi: ExtensionAPI,
  options: ModelThinkingOptions = {},
): void {
  const levelsPath = options.levelsPath ?? DEFAULT_LEVELS_PATH;

  pi.registerCommand("levels", {
    description:
      "Set per-model thinking levels (applied on switch; survives /scoped-models)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/levels requires interactive mode", "warning");
        return;
      }
      const scoped = ctx.scopedModels;
      if (scoped.length === 0) {
        ctx.ui.notify(
          "No scoped models — enable models with /scoped-models first; levels are set per enabled model.",
          "warning",
        );
        return;
      }

      const rows: LevelsRow[] = scoped.map((entry) => ({
        key: modelKey(entry.model),
        ladder: buildLadder(entry.model),
      }));
      const values = readStoredLevels(levelsPath);
      const activeKey = ctx.model ? modelKey(ctx.model) : undefined;

      const result = await ctx.ui.custom<
        Record<string, StoredLevel> | undefined
      >(
        (_tui, theme, _keybindings, done) =>
          new LevelsSelectorComponent(
            "Thinking levels",
            rows,
            activeKey,
            { ...values },
            theme,
            done,
          ),
      );
      if (result === undefined) return;

      writeStoredLevels(result, levelsPath);
      applyStoredLevel(pi, ctx, true, levelsPath);
      ctx.ui.notify("Saved thinking levels", "info");
    },
  });

  pi.on("model_select", (event, ctx) => {
    // A restored session owns its historical thinking level.
    if (event.source === "restore") return;
    applyStoredLevel(pi, ctx, true, levelsPath);
  });

  pi.on("session_start", (event, ctx) => {
    // Pi restores these sessions' model and thinking level from the session.
    // Reload preserves the current session, so applying the stored level
    // there would clobber a manual change.
    if (
      event.reason === "reload" ||
      event.reason === "resume" ||
      event.reason === "fork"
    ) {
      return;
    }
    // Explicit CLI thinking intent wins for the launched session.
    if (event.reason === "startup" && explicitCliThinking()) return;
    // /new: pi starts the fresh session on the saved default model; snap
    // the level to that model's stored level.
    applyStoredLevel(pi, ctx, event.reason === "new", levelsPath);
  });
}
