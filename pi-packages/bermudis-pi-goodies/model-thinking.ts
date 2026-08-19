/**
 * Per-model thinking levels, stored in an extension-owned sidecar file.
 *
 * Pi's native home for this is the `enabledModels` scoped-models config
 * ("zai/glm-5.3:high"), but pi's /scoped-models screen rewrites
 * enabledModels with bare model ids, destroying any :level suffix on every
 * save. Rather than fight that writer, levels live in a sidecar keyed by
 * provider/id, plus a separate logical global default. Keeping the latter is
 * necessary because Pi persists every setThinkingLevel() call as its global
 * default:
 *
 *   ~/.pi/agent/data/bermudis-pi-goodies/thinking-levels.json
 *   ~/.pi/agent/data/bermudis-pi-goodies/thinking-default.json
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
  Key,
  matchesKey,
  Spacer,
  Text,
  getKeybindings,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

function defaultLevelPath(levelsPath: string): string {
  return join(dirname(levelsPath), "thinking-default.json");
}

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

function readInheritedLevel(path: string): StoredLevel | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
      throw new Error("default level is not a valid thinking level");
    }
    return value as StoredLevel;
  } catch (error) {
    console.error(`[model-thinking] ignoring invalid ${path}:`, error);
    return undefined;
  }
}

/**
 * Apply just this dialog's changes to a freshly-read sidecar.  The dialog
 * may have been open while another Pi session saved its own rows, so writing
 * `edited` wholesale would discard those rows.
 */
export function mergeStoredLevels(
  initial: Readonly<Record<string, StoredLevel>>,
  edited: Readonly<Record<string, StoredLevel>>,
  current: Readonly<Record<string, StoredLevel>>,
  rows: readonly { key: string }[],
): Record<string, StoredLevel> {
  const merged: Record<string, StoredLevel> = { ...current };
  for (const row of rows) {
    const was = initial[row.key];
    const next = edited[row.key];
    if (was === next) continue;
    if (next === undefined) delete merged[row.key];
    else merged[row.key] = next;
  }
  return merged;
}

const SIDECAR_LOCK_WAIT_MS = 10;
const SIDECAR_LOCK_TIMEOUT_MS = 5_000;
const STALE_SIDECAR_LOCK_MS = 30_000;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

/**
 * Serialize the read/merge/write transaction across Pi processes. Atomic
 * rename alone cannot prevent two dialogs that close at the same instant
 * from both reading the same old sidecar and overwriting each other.
 */
function withSidecarLock<T>(path: string, operation: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + SIDECAR_LOCK_TIMEOUT_MS;
  let descriptor: number | undefined;

  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      // A crashed process must not block /levels forever. A normal locked
      // transaction only reads and renames one small file, so 30 seconds is
      // deliberately generous.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_SIDECAR_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw lockError;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for thinking-level sidecar lock`);
      }
      Atomics.wait(lockWaitArray, 0, 0, SIDECAR_LOCK_WAIT_MS);
    }
  }

  let result: T | undefined;
  let operationError: unknown;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    closeSync(descriptor);
    unlinkSync(lockPath);
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      `failed to update ${path} and release its lock`,
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return result as T;
}

function mergeAndWriteStoredLevels(
  initial: Readonly<Record<string, StoredLevel>>,
  edited: Readonly<Record<string, StoredLevel>>,
  rows: readonly { key: string }[],
  path: string,
): void {
  withSidecarLock(path, () => {
    writeStoredLevels(
      mergeStoredLevels(initial, edited, readStoredLevels(path), rows),
      path,
    );
  });
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
  restoreInherited: boolean,
  inheritedLevel: ThinkingLevel,
  source?: "set" | "cycle",
  setManagedLevel?: (level: ThinkingLevel) => void,
): void {
  const model = ctx.model;
  if (!model) return;
  // A native scoped level for this session (via --models "x:level" or a
  // hand-suffixed enabledModels entry) is pi-owned state; the sidecar only
  // fills in where pi has no level, never overrides one.
  const scoped = ctx.scopedModels.find((entry) =>
    sameModel(entry.model, model),
  );
  if (scoped?.thinkingLevel !== undefined) {
    // Pi applies a pinned level while cycling scoped models, but direct
    // selection from the full picker goes through setModel() and carries the
    // previous level instead. Apply the pin in that one missing path.
    if (source === "set") {
      (setManagedLevel ?? pi.setThinkingLevel.bind(pi))(scoped.thinkingLevel);
    }
    return;
  }

  const level = readStoredLevels(levelsPath)[modelKey(model)];
  if (level === undefined && !restoreInherited) return;

  const before = pi.getThinkingLevel();
  // "off" is a valid runtime level (pi clamps per model); the declared API
  // type only models the non-off ladder.
  (setManagedLevel ?? pi.setThinkingLevel.bind(pi))(
    (level ?? inheritedLevel) as ThinkingLevel,
  );
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
  private static readonly maxVisibleRows = 7;
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
    private readonly keybindings: KeybindingsManager = getKeybindings(),
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
    const start = Math.max(
      0,
      Math.min(
        this.selectedIndex -
          Math.floor(LevelsSelectorComponent.maxVisibleRows / 2),
        this.rows.length - LevelsSelectorComponent.maxVisibleRows,
      ),
    );
    const end = Math.min(
      start + LevelsSelectorComponent.maxVisibleRows,
      this.rows.length,
    );
    for (let index = start; index < end; index++) {
      const row = this.rows[index];
      if (!row) continue;
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
    if (start > 0 || end < this.rows.length) {
      this.listContainer.addChild(
        new Text(
          this.theme.fg(
            "muted",
            `  (${this.selectedIndex + 1}/${this.rows.length})`,
          ),
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
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, "k")
    ) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.updateList();
    } else if (
      this.keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, "j")
    ) {
      this.selectedIndex = Math.min(
        this.rows.length - 1,
        this.selectedIndex + 1,
      );
      this.updateList();
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.finish(this.collect());
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish(undefined);
    } else if (matchesKey(data, Key.left) || matchesKey(data, "h")) {
      this.cycle(-1);
    } else if (matchesKey(data, Key.right) || matchesKey(data, "l")) {
      this.cycle(1);
    }
  }
}

export interface ModelThinkingOptions {
  /** Override the sidecar path (tests). */
  levelsPath?: string;
  /** Override the logical global-default sidecar path (tests). */
  inheritedLevelPath?: string;
}

export default function modelThinking(
  pi: ExtensionAPI,
  options: ModelThinkingOptions = {},
): void {
  const levelsPath = options.levelsPath ?? DEFAULT_LEVELS_PATH;
  const inheritedLevelPath =
    options.inheritedLevelPath ?? defaultLevelPath(levelsPath);
  // Pi exposes the active level but not the persisted setting that supplied
  // it. Capture it before this extension applies a model-specific value:
  // setThinkingLevel() writes its argument back as Pi's global default.
  // Keep that value separately so a prior session's scoped value cannot
  // become this session's default through Pi's settings writer.
  const savedInheritedLevel = readInheritedLevel(inheritedLevelPath);
  let inheritedLevel = savedInheritedLevel ?? pi.getThinkingLevel();
  if (savedInheritedLevel === undefined) {
    writeJsonFileAtomic(inheritedLevelPath, inheritedLevel);
  }
  // Counter-based managed-event suppression. Pi emits
  // thinking_level_select synchronously inside setThinkingLevel (the
  // handler runs before the first await in emit). Increment before the
  // call; the event handler decrements. If no event fires (clamped to the
  // same value), decrement here. Unlike a level-matching queue, a counter
  // is immune to clamping (the event level may differ from the requested
  // level) and never leaves stale entries.
  let managedSetCount = 0;
  const setManagedLevel = (level: ThinkingLevel): void => {
    const before = pi.getThinkingLevel();
    if (before === level) return;
    managedSetCount++;
    pi.setThinkingLevel(level);
    const effective = pi.getThinkingLevel();
    if (effective === before) managedSetCount--;
  };

  // Deferred save: Pi also emits thinking_level_select automatically when
  // switching models or applying native scoped levels — always before
  // model_select, in the same macrotask. By deferring the save to the next
  // macrotask (setTimeout 0), model_select and session_start can cancel it
  // before it fires. A genuine user key press is a separate macrotask, so
  // the timer completes and the save takes effect.
  let pendingSave: {
    level: ThinkingLevel;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  function scheduleInheritedSave(level: ThinkingLevel): void {
    if (pendingSave) clearTimeout(pendingSave.timer);
    pendingSave = {
      level,
      timer: setTimeout(() => {
        inheritedLevel = pendingSave!.level;
        writeJsonFileAtomic(inheritedLevelPath, inheritedLevel);
        pendingSave = null;
      }, 0),
    };
  }

  function cancelPendingInheritedSave(): void {
    if (pendingSave) {
      clearTimeout(pendingSave.timer);
      pendingSave = null;
    }
  }

  pi.on("thinking_level_select", (event) => {
    if (managedSetCount > 0) {
      managedSetCount--;
      return;
    }
    scheduleInheritedSave(event.level);
  });

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
        (_tui, theme, keybindings, done) =>
          new LevelsSelectorComponent(
            "Thinking levels",
            rows,
            activeKey,
            { ...values },
            theme,
            done,
            keybindings,
          ),
      );
      if (result === undefined) return;

      // Read again after the dialog closes.  This preserves edits another
      // session made while this one was open; only rows changed here win.
      mergeAndWriteStoredLevels(values, result, rows, levelsPath);
      applyStoredLevel(
        pi,
        ctx,
        true,
        levelsPath,
        true,
        inheritedLevel,
        undefined,
        setManagedLevel,
      );
      ctx.ui.notify("Saved thinking levels", "info");
    },
  });

  pi.on("model_select", (event, ctx) => {
    // Cancel a pending save from the thinking_level_select that Pi emits
    // just before model_select during a model switch — that level change is
    // Pi-internal (native scoped level, re-clamping), not a user choice.
    cancelPendingInheritedSave();
    // A restored session owns its historical thinking level.
    if (event.source === "restore") return;
    applyStoredLevel(
      pi,
      ctx,
      true,
      levelsPath,
      true,
      inheritedLevel,
      event.source === "set" || event.source === "cycle"
        ? event.source
        : undefined,
      setManagedLevel,
    );
  });

  pi.on("session_start", (event, ctx) => {
    // Same cancellation as model_select: Pi may emit thinking_level_select
    // during session creation before session_start fires.
    cancelPendingInheritedSave();
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
    // /new and ordinary startup: snap the level to the active model's
    // stored level, or restore the preserved global default when the model
    // has no stored level. The latter is necessary because Pi persists every
    // setThinkingLevel() call as its global default — a prior session's
    // scoped value pollutes it, and only the sidecar can recover the true
    // default.
    applyStoredLevel(
      pi,
      ctx,
      event.reason === "new",
      levelsPath,
      true,
      inheritedLevel,
      undefined,
      setManagedLevel,
    );
  });
}
