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
 * with source "restore" is ignored). pi --continue and startup-picker
 * resumes also emit session_start with reason "startup" but carry restored
 * conversation entries; those are detected by looking for message entries
 * (Pi seeds every new session with model_change/thinking_level_change
 * before session_start, so a non-empty entry list alone is not evidence of
 * a resume) and left alone — unless a bare --model (without :level) was
 * passed, in which case the user explicitly chose a model for the resumed
 * session and its stored level applies. Pi emits model_select only when
 * the model actually changes, so re-selecting the already-active model in
 * the full picker fires no event and its stored level cannot re-apply
 * there.
 */
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  getAgentDir,
  keyText,
  Theme,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
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

const THINKING_LEVEL_ORDER: readonly StoredLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const THINKING_LEVELS = new Set<StoredLevel>(THINKING_LEVEL_ORDER);

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
    if (
      typeof value !== "string" ||
      !THINKING_LEVELS.has(value as StoredLevel)
    ) {
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

/**
 * Serialize the read/merge/write transaction across Pi processes. Atomic
 * rename alone cannot prevent two dialogs that close at the same instant
 * from both reading the same old sidecar and overwriting each other.
 */
async function withSidecarLock<T>(
  path: string,
  operation: () => T,
): Promise<T> {
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
      await new Promise((resolve) => setTimeout(resolve, SIDECAR_LOCK_WAIT_MS));
    }
  }

  try {
    return operation();
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // Best effort: the descriptor may already be invalid.
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Best effort: the lock file may already be gone; the sidecar was
      // already written under the held descriptor.
    }
  }
}

async function mergeAndWriteStoredLevels(
  initial: Readonly<Record<string, StoredLevel>>,
  edited: Readonly<Record<string, StoredLevel>>,
  rows: readonly { key: string }[],
  path: string,
): Promise<void> {
  await withSidecarLock(path, () => {
    writeStoredLevels(
      mergeStoredLevels(initial, edited, readStoredLevels(path), rows),
      path,
    );
  });
}

/** The level ladder a row can cycle through: inherit + the model's levels. */
export function buildLadder(model: Model): (StoredLevel | undefined)[] {
  const levels = [...getSupportedThinkingLevels(model)] as StoredLevel[];
  levels.sort(
    (a, b) => THINKING_LEVEL_ORDER.indexOf(a) - THINKING_LEVEL_ORDER.indexOf(b),
  );
  return [undefined, ...levels];
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
      if (THINKING_LEVELS.has(level as StoredLevel)) thinking = level;
    }
  }
  if (thinking !== undefined) return true;
  if (model !== undefined) {
    const colon = model.lastIndexOf(":");
    if (colon > 0 && THINKING_LEVELS.has(model.slice(colon + 1) as StoredLevel))
      return true;
  }
  return false;
}

/**
 * Detect a bare --model flag (without a :level suffix) on the CLI. This
 * signals that the user explicitly chose a model for the session — even
 * when resuming via pi --continue. In that case the stored sidecar level
 * for the requested model should apply, rather than keeping the resumed
 * session's restored level. Mirrors the same parseArgs edge cases as
 * explicitCliThinking: the last --model wins, a trailing flag without a
 * value token sets nothing, and the equals form is not parsed by Pi.
 */
function explicitCliModelSelection(): boolean {
  if (explicitCliThinking()) return false; // :level or --thinking already handled
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--model" && index + 1 < args.length) return true;
  }
  return false;
}

function sameModel(
  left: Pick<Model, "provider" | "id">,
  right: Pick<Model, "provider" | "id">,
): boolean {
  return left.provider === right.provider && left.id === right.id;
}

/**
 * Distinguish a resumed conversation from a fresh session at startup.
 * Pi seeds every new session with an initial `model_change` and
 * `thinking_level_change` before `session_start` fires, so a non-empty
 * entry list is NOT evidence of a resume. A resumed session (`pi --continue`,
 * startup-picker resume) carries real messages; a fresh one does not.
 */
function hasConversationEntries(
  sessionManager: ExtensionContext["sessionManager"],
): boolean {
  return sessionManager.getEntries().some((entry) => entry.type === "message");
}

type ThinkingEntry = Extract<SessionEntry, { type: "thinking_level_change" }>;

interface BranchThinkingTransition {
  entry: ThinkingEntry;
  index: number;
  previousLevel: ThinkingLevel | undefined;
}

/**
 * Reconstruct thinking transitions from the durable branch. Extension
 * thinking events have no ID, so their payload alone cannot tell us whether a
 * delayed event belongs to Pi's model-switch re-clamp or to a later user
 * change. The branch does have IDs and parent ordering, which is enough:
 *
 * - Pi's re-clamp and this extension's model-specific apply are marked as
 *   ignored entries.
 * - A user event is stale when a later, non-ignored thinking entry already
 *   exists, even if its handler arrived first.
 *
 * `undefined` is solely for the deliberately minimal unit-test context.
 */
function classifyBranchThinkingEvent(
  event: { level: ThinkingLevel; previousLevel: ThinkingLevel },
  ctx: ExtensionContext,
  ignoredThinkingEntryIds: ReadonlySet<string>,
  knownModelChangeIds: ReadonlySet<string>,
): "internal" | "stale" | "user" | undefined {
  const sessionManager = (
    ctx as unknown as {
      sessionManager?: { getBranch?: () => SessionEntry[] };
    }
  ).sessionManager;
  if (!sessionManager?.getBranch) return undefined;

  const branch = sessionManager.getBranch();
  const transitions: BranchThinkingTransition[] = [];
  let previousLevel: ThinkingLevel | undefined;
  branch.forEach((entry, index) => {
    if (entry.type !== "thinking_level_change") return;
    transitions.push({ entry, index, previousLevel });
    previousLevel = entry.thinkingLevel as ThinkingLevel;
  });

  const candidates = transitions.filter(
    (transition) =>
      transition.previousLevel === event.previousLevel &&
      transition.entry.thinkingLevel === event.level,
  );
  const candidate = candidates.at(-1);
  if (!candidate) {
    const latest = transitions.at(-1);
    if (!latest) return undefined;
    return ignoredThinkingEntryIds.has(latest.entry.id) ? "internal" : "user";
  }

  // A later user transition means this event is stale. Delayed events from
  // Pi's re-clamp are handled the same way: their durable entry is ignored,
  // while a later user entry wins.
  if (
    transitions.some(
      (transition) =>
        transition.index > candidate.index &&
        !ignoredThinkingEntryIds.has(transition.entry.id),
    )
  ) {
    return "stale";
  }
  if (ignoredThinkingEntryIds.has(candidate.entry.id)) return "internal";

  // Before model_select runs, the just-appended direct child is Pi's own
  // re-clamp. This closes the small synchronous window before its entry can
  // be recorded in knownModelChangeIds.
  const parent = branch.find((entry) => entry.id === candidate.entry.parentId);
  if (parent?.type === "model_change" && !knownModelChangeIds.has(parent.id)) {
    return "internal";
  }
  return "user";
}

function branchEntries(
  ctx: ExtensionContext,
): { getBranch?: () => SessionEntry[] } | undefined {
  return (
    ctx as unknown as {
      sessionManager?: { getBranch?: () => SessionEntry[] };
    }
  ).sessionManager;
}

function markModelSwitchEntries(
  ctx: ExtensionContext,
  model: Pick<Model, "provider" | "id">,
  knownModelChangeIds: Set<string>,
  ignoredThinkingEntryIds: Set<string>,
): string[] {
  const branch = branchEntries(ctx)?.getBranch?.();
  if (!branch) return [];
  const modelChange = [...branch]
    .reverse()
    .find(
      (entry) =>
        entry.type === "model_change" &&
        entry.provider === model.provider &&
        entry.modelId === model.id,
    );
  if (!modelChange || modelChange.type !== "model_change") return [];

  knownModelChangeIds.add(modelChange.id);
  for (const entry of branch) {
    if (
      entry.type === "thinking_level_change" &&
      entry.parentId === modelChange.id
    ) {
      ignoredThinkingEntryIds.add(entry.id);
    }
  }
  return branch.map((entry) => entry.id);
}

function markNewThinkingEntries(
  ctx: ExtensionContext,
  beforeIds: ReadonlySet<string>,
  ignoredThinkingEntryIds: Set<string>,
): void {
  const branch = branchEntries(ctx)?.getBranch?.();
  if (!branch) return;
  for (const entry of branch) {
    if (entry.type === "thinking_level_change" && !beforeIds.has(entry.id)) {
      ignoredThinkingEntryIds.add(entry.id);
    }
  }
}

function applyStoredLevel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  notify: boolean,
  levelsPath: string,
  inheritedLevel: ThinkingLevel,
  source?: "set" | "cycle",
  setManagedLevel?: (level: ThinkingLevel, model: Model) => void,
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
    // selection from the full picker (set) and startup / /new (undefined)
    // both carry the previous level instead. Apply the pin in those paths.
    // "cycle" is left to Pi, which already applies the scoped level there.
    if (source === "set" || source === undefined) {
      (setManagedLevel ?? pi.setThinkingLevel.bind(pi))(
        scoped.thinkingLevel,
        model,
      );
    }
    return;
  }

  const level = readStoredLevels(levelsPath)[modelKey(model)];
  const before = pi.getThinkingLevel();
  // "off" is a valid runtime level (pi clamps per model); the declared API
  // type only models the non-off ladder.
  (setManagedLevel ?? pi.setThinkingLevel.bind(pi))(
    (level ?? inheritedLevel) as ThinkingLevel,
    model,
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
  /** A native scoped-model thinking level; if set, this row is read-only. */
  native?: StoredLevel;
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

  private levelLabel(row: LevelsRow): string {
    if (row.native !== undefined) return `native: ${row.native}`;
    return this.values[row.key] ?? "inherit";
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
      const level = this.levelLabel(row);
      const levelText =
        row.native !== undefined
          ? this.theme.fg("muted", level)
          : level === "inherit"
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
    if (!row || row.native !== undefined) return;
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
  //
  // The capture is deferred to the first event handler (lazy init) because
  // pi.getThinkingLevel() is a runtime action that throws during extension
  // loading. In real Pi the level does not change between load and the first
  // event, so the deferred capture is equivalent to a factory-time capture.
  const savedInheritedLevel = readInheritedLevel(inheritedLevelPath);
  let inheritedLevel: ThinkingLevel | undefined = savedInheritedLevel;
  // Only a fresh session (ordinary startup, /new) may persist the lazily
  // captured level as the global default. Resumed, reloaded, forked, and
  // CLI-override sessions carry a session-specific level that must not be
  // written to the default sidecar — doing so would permanently overwrite
  // the true global default with a session override (Finding 5).
  let canPersistInheritedLevel = false;
  function getInheritedLevel(): ThinkingLevel {
    if (inheritedLevel === undefined) {
      inheritedLevel = pi.getThinkingLevel();
      if (canPersistInheritedLevel) {
        writeJsonFileAtomic(inheritedLevelPath, inheritedLevel);
      }
    }
    return inheritedLevel;
  }
  // Pi emits thinking_level_select without awaiting it. Match a managed
  // event by its actual before/after pair, not a counter: an unrelated user
  // change is allowed to overtake a delayed managed event.
  const managedTransitions: {
    previousLevel: ThinkingLevel;
    level: ThinkingLevel;
  }[] = [];
  const ignoredThinkingEntryIds = new Set<string>();
  const knownModelChangeIds = new Set<string>();
  const setManagedLevel = (level: ThinkingLevel, model: Model): void => {
    const before = pi.getThinkingLevel();
    // Unit rows intentionally contain only provider/id. Real Pi models always
    // have `reasoning`; use the requested level for those small test doubles.
    const effective =
      model.reasoning === undefined
        ? level
        : (clampThinkingLevel(model, level) as ThinkingLevel);
    if (before === effective) return;
    managedTransitions.push({ previousLevel: before, level: effective });
    pi.setThinkingLevel(level);
  };

  // Unit tests use a deliberately partial ExtensionContext and therefore
  // cannot inspect Pi's session branch. Keep the old expected-level fallback
  // only for that test-only situation; production uses the durable
  // model-change/thinking-change ordering in classifyBranchThinkingEvent().
  let switchExpectedLevel: ThinkingLevel | undefined;
  // The level Pi's re-clamp set inside setModel, captured before
  // applyStoredLevel overwrites it. Used to distinguish stale re-clamp
  // events from genuine user changes overtaken by a model switch (Finding 3).
  let switchReclampLevel: ThinkingLevel | undefined;
  // Whether the current switch's re-clamp was a no-op (Pi's setThinkingLevel
  // inside setModel didn't change the level, so no thinking_level_select
  // event was emitted for it). When true, branch classification
  // results are false positives — a subsequent user thinking change matches
  // the same branch pattern (thinking_level_change at -1, model_change at
  // -2) because no re-clamp thinking_level_change was appended between them.
  // Computed by comparing switchReclampLevel with lastSettledLevel (the
  // pre-switch level). Cleared after each thinking_level_select event so it
  // doesn't leak across switches.
  let switchReclampWasNoOp: boolean | undefined;
  // Tracks pi.getThinkingLevel() at the end of every handler. Used to
  // compute switchReclampWasNoOp in model_select.
  let lastSettledLevel: ThinkingLevel | undefined;
  let pendingFallbackSave:
    | {
        level: ThinkingLevel;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  function scheduleFallbackSave(level: ThinkingLevel): void {
    if (pendingFallbackSave) clearTimeout(pendingFallbackSave.timer);
    pendingFallbackSave = {
      level,
      timer: setTimeout(() => {
        const next = pendingFallbackSave!.level;
        pendingFallbackSave = undefined;
        try {
          writeJsonFileAtomic(inheritedLevelPath, next);
          inheritedLevel = next;
        } catch (error) {
          console.error(
            `[model-thinking] failed to save inherited thinking level to ${inheritedLevelPath}:`,
            error,
          );
        }
      }, 0),
    };
  }

  function cancelFallbackSave(): void {
    if (!pendingFallbackSave) return;
    clearTimeout(pendingFallbackSave.timer);
    pendingFallbackSave = undefined;
  }

  pi.on("thinking_level_select", (event, ctx) => {
    const managedIndex = managedTransitions.findIndex(
      (transition) =>
        transition.level === event.level &&
        transition.previousLevel === event.previousLevel,
    );
    if (managedIndex !== -1) {
      managedTransitions.splice(managedIndex, 1);
      return;
    }
    const branchClassification = classifyBranchThinkingEvent(
      event,
      ctx,
      ignoredThinkingEntryIds,
      knownModelChangeIds,
    );
    if (
      branchClassification === "internal" ||
      branchClassification === "stale"
    ) {
      return;
    }
    if (branchClassification === "user") {
      // Pi dispatches these events without awaiting earlier handlers. The
      // branch tells us whether a newer user transition already superseded
      // this event, so an older callback cannot overwrite the newer default.
      inheritedLevel = event.level;
      writeJsonFileAtomic(inheritedLevelPath, inheritedLevel);
      lastSettledLevel = event.level;
      return;
    }
    // Production uses the durable session-branch ordering to identify
    // Pi's internal re-clamp. Check it before the stale-event check below
    // because branch classification can distinguish a re-clamp from a
    // genuine user change even when both have event.level !== current (the
    // re-clamp's thinking_level_change is parented by the just-appended
    // model_change; a user change is not). The stale check below is a
    // fallback for the test-only path that lacks getBranch.
    const internal = undefined;
    // Consume switchReclampWasNoOp for this event so it doesn't leak across
    // switches. switchReclampLevel is NOT cleared here — it's only cleared
    // when a stale re-clamp event matches it (below). This allows a
    // subsequent re-clamp event to still be identified after a non-matching
    // user event has passed through. model_select overwrites both on the
    // next switch, so they don't leak across switches in practice.
    const reclampWasNoOp = switchReclampWasNoOp;
    switchReclampWasNoOp = undefined;
    if (internal === true) {
      // The branch pattern matches (thinking_level_change at -1, model_change
      // at -2). When the re-clamp was a no-op (switchReclampWasNoOp === true),
      // no thinking_level_change was appended by Pi, so a subsequent user
      // thinking change matches the same pattern — a false positive. In that
      // case, fall through to save the user's change. Otherwise, this is a
      // genuine re-clamp event — drop it. When switchReclampWasNoOp is
      // undefined (event arrived before model_select ran), drop it as a safe
      // default — the event must be a re-clamp, not a user change (user
      // changes only happen after setModel returns, which is after
      // model_select is dispatched).
      if (reclampWasNoOp !== true) {
        return;
      }
      // False positive: fall through to save the genuine user change.
    }
    const current = pi.getThinkingLevel();
    if (event.level !== current) {
      // The event's level no longer matches pi's current level. Two cases:
      //   1. A stale internal re-clamp from a model switch: Pi fired
      //      thinking_level_select inside setModel, but another extension's
      //      handler awaited and delayed ours past model_select. Our
      //      applyStoredLevel has since moved pi's state.
      //   2. A genuine user/extension change (e.g. setThinkingLevel("high")
      //      followed immediately by setModel(...)) that was overtaken by
      //      the model switch's applyStoredLevel (Finding 3).
      // In production, branch classification already returned false
      // (or a false positive was caught above), ruling out case 1 when the
      // branch is intact — so this is case 2, and we fall through to save
      // it. In the test-only path (internal === undefined), use
      // switchReclampLevel to distinguish: a match is case 1, a non-match
      // is case 2. When reclampWasNoOp is true, the re-clamp was a no-op
      // (no event), so this must be case 2 — save it.
      if (internal === undefined) {
        if (reclampWasNoOp === true) {
          // Re-clamp was a no-op, so this stale event is a user change.
          // Fall through to save.
        } else if (
          switchReclampLevel !== undefined &&
          event.level === switchReclampLevel
        ) {
          switchReclampLevel = undefined;
          return;
        }
        // Fall through — might be a genuine user change.
      }
      // Production (internal === false): genuine user/extension change
      // overtaken by a model switch. Fall through to save it.
    }
    if (
      internal === undefined &&
      switchExpectedLevel !== undefined &&
      event.level === switchExpectedLevel
    ) {
      // The internal re-clamp landed exactly where the switch settled.
      switchExpectedLevel = undefined;
      lastSettledLevel = pi.getThinkingLevel();
      return;
    }
    // Genuine user/extension intent (keybinding change, or an extension's
    // pi.setThinkingLevel issued after await pi.setModel). Production writes
    // immediately: the model-switch event has already been identified above,
    // so a timer would only introduce a race and let I/O errors escape Pi's
    // handler. The timer branch exists only for the partial unit-test context,
    // which lacks Pi's session branch and keeps legacy tests focused there.
    switchExpectedLevel = undefined;
    if (internal === undefined) {
      scheduleFallbackSave(event.level);
      lastSettledLevel = event.level;
      return;
    }
    inheritedLevel = event.level;
    writeJsonFileAtomic(inheritedLevelPath, inheritedLevel);
    lastSettledLevel = event.level;
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
        native:
          entry.thinkingLevel !== undefined
            ? (entry.thinkingLevel as StoredLevel)
            : undefined,
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
      await mergeAndWriteStoredLevels(values, result, rows, levelsPath);
      const beforeApplyIds = new Set(
        branchEntries(ctx)
          ?.getBranch?.()
          .map((entry) => entry.id) ?? [],
      );
      applyStoredLevel(
        pi,
        ctx,
        true,
        levelsPath,
        getInheritedLevel(),
        undefined,
        setManagedLevel,
      );
      markNewThinkingEntries(ctx, beforeApplyIds, ignoredThinkingEntryIds);
      ctx.ui.notify("Saved thinking levels", "info");
    },
  });

  pi.on("model_select", (event, ctx) => {
    cancelFallbackSave();
    // A restored session owns its historical thinking level.
    if (event.source === "restore") {
      canPersistInheritedLevel = false;
      switchExpectedLevel = pi.getThinkingLevel();
      switchReclampLevel = pi.getThinkingLevel();
      switchReclampWasNoOp = undefined;
      lastSettledLevel = pi.getThinkingLevel();
      return;
    }
    const beforeApplyIds = new Set(
      markModelSwitchEntries(
        ctx,
        event.model,
        knownModelChangeIds,
        ignoredThinkingEntryIds,
      ),
    );
    // Capture the re-clamp level (Pi's setThinkingLevel inside setModel)
    // before applyStoredLevel overwrites it. A delayed thinking_level_select
    // matching this level is the stale re-clamp and is dropped; a non-match
    // is a genuine user change overtaken by the switch (Finding 3).
    switchReclampLevel = pi.getThinkingLevel();
    // Detect whether the re-clamp was a no-op by comparing the post-re-clamp
    // level with the pre-switch level (lastSettledLevel from the previous
    // handler). When the re-clamp is a no-op, no thinking_level_select event
    // is emitted, and branch classification can produce false positives
    // for subsequent user thinking changes (Finding 3).
    switchReclampWasNoOp =
      lastSettledLevel !== undefined && switchReclampLevel === lastSettledLevel;
    applyStoredLevel(
      pi,
      ctx,
      true,
      levelsPath,
      getInheritedLevel(),
      event.source === "set" || event.source === "cycle"
        ? event.source
        : undefined,
      setManagedLevel,
    );
    markNewThinkingEntries(ctx, beforeApplyIds, ignoredThinkingEntryIds);
    // Record the level the switch settled at so a delayed internal
    // thinking_level_select (case 2 above) is recognized and dropped.
    switchExpectedLevel = pi.getThinkingLevel();
    lastSettledLevel = pi.getThinkingLevel();
  });

  pi.on("session_start", (event, ctx) => {
    cancelFallbackSave();
    // Pi restores these sessions' model and thinking level from the session.
    // Reload preserves the current session, so applying the stored level
    // there would clobber a manual change. The inherited default must not
    // be persisted from these session-specific levels (Finding 5).
    if (
      event.reason === "reload" ||
      event.reason === "resume" ||
      event.reason === "fork"
    ) {
      canPersistInheritedLevel = false;
      switchExpectedLevel = pi.getThinkingLevel();
      switchReclampLevel = pi.getThinkingLevel();
      switchReclampWasNoOp = undefined;
      lastSettledLevel = pi.getThinkingLevel();
      return;
    }
    // Explicit CLI thinking intent wins for the launched session.
    if (event.reason === "startup" && explicitCliThinking()) {
      canPersistInheritedLevel = false;
      switchExpectedLevel = pi.getThinkingLevel();
      switchReclampLevel = pi.getThinkingLevel();
      switchReclampWasNoOp = undefined;
      lastSettledLevel = pi.getThinkingLevel();
      return;
    }
    // pi --continue and the startup-picker resume an existing session but
    // emit reason "startup" (not "resume"). Distinguish them from a fresh
    // session by looking for conversation entries: Pi appends an initial
    // model_change and thinking_level_change to every new session (even
    // before session_start), so a non-empty entry list is NOT evidence of a
    // resume. A resumed session carries real messages; a fresh one does not.
    // The restored thinking level must survive, not be replaced by the
    // sidecar's default — UNLESS the user passed a bare --model (without
    // :level), which means they explicitly chose a model for the resumed
    // session and its stored level should apply (Finding 4).
    const resumed =
      event.reason === "startup" && hasConversationEntries(ctx.sessionManager);
    canPersistInheritedLevel = !resumed;
    if (resumed && !explicitCliModelSelection()) {
      switchExpectedLevel = pi.getThinkingLevel();
      switchReclampLevel = pi.getThinkingLevel();
      switchReclampWasNoOp = undefined;
      lastSettledLevel = pi.getThinkingLevel();
      return;
    }
    // /new, ordinary startup, and pi --continue --model X: snap the level to
    // the active model's stored level, or restore the preserved global
    // default when the model has no stored level. The latter is necessary
    // because Pi persists every setThinkingLevel() call as its global
    // default — a prior session's scoped value pollutes it, and only the
    // sidecar can recover the true default. For --continue --model X,
    // canPersistInheritedLevel is false so the resumed session's level is
    // not written as the global default (Finding 5).
    switchReclampLevel = pi.getThinkingLevel();
    switchReclampWasNoOp =
      lastSettledLevel !== undefined && switchReclampLevel === lastSettledLevel;
    const beforeApplyIds = new Set(
      branchEntries(ctx)
        ?.getBranch?.()
        .map((entry) => entry.id) ?? [],
    );
    applyStoredLevel(
      pi,
      ctx,
      event.reason === "new",
      levelsPath,
      getInheritedLevel(),
      undefined,
      setManagedLevel,
    );
    markNewThinkingEntries(ctx, beforeApplyIds, ignoredThinkingEntryIds);
    switchExpectedLevel = pi.getThinkingLevel();
    lastSettledLevel = pi.getThinkingLevel();
  });
}
