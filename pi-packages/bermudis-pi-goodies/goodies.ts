/**
 * Feature toggles for bermudis-pi-goodies.
 *
 * Lets you turn individual parts of the bundle on/off without losing the rest.
 * Example: if clean-tui freezes pi, run `/goodies disable clean-tui` and keep
 * kilo, provider-balance, etc.
 *
 * State persists to ~/.pi/agent/goodies.json. Toggling a feature writes the
 * config but does NOT unload/reload the extension — every feature is registered
 * at load time, so a toggle needs `/reload` or a new session to take effect.
 * Exceptions read at request time: `summary-model` and `thinking-summaries`.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { reportFailure } from "./goodies-log.ts";
import { writeJsonFileAtomic, describeError } from "./json-file.ts";
import { pickModel } from "./pick-model.ts";
import { rankCandidates } from "./vision-core.ts";

let CONFIG_PATH = join(homedir(), ".pi", "agent", "goodies.json");

export function __setConfigPathForTesting(path: string): void {
  CONFIG_PATH = path;
  config = loadConfig();
}

type FeatureName =
  | "copy-with-model"
  | "copy-trajectory"
  | "name-with-ai"
  | "prefer-tools"
  | "keep-model"
  | "model-thinking"
  | "model-identity"
  | "clean-tui"
  | "review"
  | "kilo"
  | "provider-balance"
  | "tps"
  | "vision"
  | "side"
  | "fusion"
  | "recap";

const FEATURES: FeatureName[] = [
  "copy-with-model",
  "copy-trajectory",
  "name-with-ai",
  "prefer-tools",
  "keep-model",
  "model-thinking",
  "model-identity",
  "clean-tui",
  "review",
  "kilo",
  "provider-balance",
  "tps",
  "vision",
  "side",
  "fusion",
  "recap",
];

type Config = Partial<Record<FeatureName, boolean>> & {
  /**
   * Model ("provider/id") clean-tui uses for AI command summaries, resolved
   * through the user's own pi model registry (its providers and auth).
   * Unset means the feature is off.
   */
  "summary-model"?: string;
  /**
   * Whether live thinking summaries are on. Persisted like every other
   * toggle; read at request time so `/goodies thinking-summaries on|off`
   * takes effect immediately. Unset means off — the volume (a request per
   * reasoning run, not per command) is why the default stays off.
   */
  "thinking-summaries"?: boolean;
  /**
   * Minutes of no new messages before recap generates one automatically.
   * 0 disables the idle timer. Unset means 10.
   */
  "recap-idle-minutes"?: number;
  /**
   * Whether resuming a session triggers an automatic recap. Unset means on.
   */
  "recap-on-resume"?: boolean;
  /**
   * Model ("provider/id") that writes recaps. Unset means the session's
   * active model. `/recap provider/id` still overrides it for one run.
   */
  "recap-model"?: string;
  /**
   * How many of the most recent user messages (and everything after the
   * first of them) the recap model reads. Unset means 2.
   */
  "recap-turns"?: number;
};

function loadConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    // Valid JSON is not necessarily a config object: null, true, "x", 42, or
    // [] all parse cleanly but would crash later code (config[name] on null,
    // delete on a string index, etc.). Reject anything that isn't a plain
    // object so this path logs config_error and returns defaults, the same as
    // a syntax error — a non-object root is just as unusable.
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new TypeError(
        `goodies.json root must be a JSON object, got ${
          parsed === null
            ? "null"
            : Array.isArray(parsed)
              ? "array"
              : typeof parsed
        }`,
      );
    }
    return parsed as Config;
  } catch (err) {
    // A corrupt goodies.json must not silently reset every feature to its
    // default — that would hide the problem (the user wonders why all their
    // toggles reverted) and overwrite the corrupt file on the next save,
    // destroying the evidence. Log it so the cause is queryable.
    if (!(
      err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
    )) {
      reportFailure(
        "config_error",
        `goodies: failed to load config from ${CONFIG_PATH}: ${describeError(
          err,
        )} — using defaults`,
      );
    }
    return {};
  }
}

function saveConfig(config: Config): void {
  try {
    writeJsonFileAtomic(CONFIG_PATH, config);
  } catch (err) {
    reportFailure(
      "config_error",
      `goodies: failed to save config: ${describeError(err)}`,
    );
  }
}

let config = loadConfig();

/**
 * Every config write re-reads the file first. Several pi sessions share
 * ~/.pi/agent/goodies.json and each caches it from its own startup, so writing
 * the cached copy back would silently revert settings another session changed
 * since — how a configured summary-model kept disappearing under a session
 * that only ever toggled an unrelated feature.
 */
function updateConfig(mutate: (config: Config) => void): void {
  config = loadConfig();
  mutate(config);
  saveConfig(config);
}

export function isEnabled(name: FeatureName): boolean {
  return config[name] !== false; // default true
}

export function setEnabled(name: FeatureName, enabled: boolean): void {
  updateConfig((next) => {
    next[name] = enabled;
  });
}

export function listFeatures(): Array<{ name: FeatureName; enabled: boolean }> {
  return FEATURES.map((name) => ({ name, enabled: isEnabled(name) }));
}

export function getSummaryModel(): string | undefined {
  const v = config["summary-model"];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function setSummaryModel(model: string | undefined): void {
  updateConfig((next) => {
    if (model === undefined || model.trim() === "") {
      delete next["summary-model"];
    } else {
      next["summary-model"] = model.trim();
    }
  });
}

export function getThinkingSummariesEnabled(): boolean {
  return config["thinking-summaries"] === true; // default off when unset
}

export function setThinkingSummariesEnabled(enabled: boolean): void {
  updateConfig((next) => {
    next["thinking-summaries"] = enabled;
  });
}

export function getRecapIdleMinutes(): number {
  const v = config["recap-idle-minutes"];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 10;
}

export function setRecapIdleMinutes(minutes: number): void {
  updateConfig((next) => {
    next["recap-idle-minutes"] = minutes;
  });
}

export function getRecapOnResume(): boolean {
  return config["recap-on-resume"] !== false; // default on when unset
}

export function setRecapOnResume(enabled: boolean): void {
  updateConfig((next) => {
    next["recap-on-resume"] = enabled;
  });
}

export const RECAP_DEFAULT_TURNS = 2;
export const RECAP_MAX_TURNS = 20;

export function getRecapModel(): string | undefined {
  const v = config["recap-model"];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function setRecapModel(model: string | undefined): void {
  updateConfig((next) => {
    if (model === undefined || model.trim() === "") {
      delete next["recap-model"];
    } else {
      next["recap-model"] = model.trim();
    }
  });
}

export function getRecapTurns(): number {
  const v = config["recap-turns"];
  return typeof v === "number" && Number.isInteger(v) && v >= 1
    ? Math.min(v, RECAP_MAX_TURNS)
    : RECAP_DEFAULT_TURNS;
}

export function setRecapTurns(turns: number | undefined): void {
  updateConfig((next) => {
    if (turns === undefined) delete next["recap-turns"];
    else next["recap-turns"] = turns;
  });
}

// ── Summary-model resolution against pi's model registry ────────────────────

/**
 * Structural slice of pi's ModelRegistry needed for summary-model work.
 * Declared here so both the /goodies command and clean-tui's summary engine
 * can depend on it while tests substitute fakes.
 */
export interface SummaryModelRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getAvailable(): Model<Api>[];
  /**
   * Resolves env keys, models.json auth, and refreshes OAuth tokens for the
   * provider serving `model`.
   */
  getApiKeyAndHeaders(
    model: Model<Api>,
  ): Promise<
    | { ok: true; apiKey?: string; headers?: Record<string, string | null> }
    | { ok: false; error: string }
  >;
  /** Advisory only: true when the provider already has usable auth. */
  hasConfiguredAuth?(model: Model<Api>): boolean;
}

/**
 * Resolve a summary-model config value against the registry.
 *
 * Accepts an exact "provider/id" pair first. Falls back to matching the value
 * as a bare model id, because config values written by older versions were
 * never provider-prefixed and would otherwise silently break.
 */
export function findSummaryModel(
  registry: SummaryModelRegistry,
  value: string,
): Model<Api> | undefined {
  const slash = value.indexOf("/");
  if (slash > 0 && slash < value.length - 1) {
    const exact = registry.find(value.slice(0, slash), value.slice(slash + 1));
    if (exact) return exact;
  }
  return registry.getAvailable().find((m) => m.id === value);
}

/** Best-effort alternatives for a value the registry doesn't know. */
export function suggestSummaryModels(
  registry: SummaryModelRegistry,
  value: string,
  limit = 5,
): string[] {
  const q = value.toLowerCase();
  if (!q) return [];
  const terms = q.split(/[\s/]+/).filter(Boolean);
  // Kebab-cased model ids miss whole-term matching when users mistype one
  // segment ("grok-4-x-typo"), so longer dash-separated fragments also count.
  const fragments = q.split(/[\s/-]+/).filter((f) => f.length >= 4);
  // Rank, don't just filter: the first version took the first `limit`
  // registry matches, so the obvious answer ("1min/grok-4-fast-non-reasoning"
  // for a mistyped "1min/grok-4-fast-nonthinking") could be cut by unrelated
  // models that merely sat earlier in the registry. Longest-common-prefix
  // dominates — the mistyped tail of the right provider/family is the
  // strongest signal — with substring hits as the fallback for queries that
  // omit or garble the provider entirely.
  return registry
    .getAvailable()
    .map((m) => {
      const hay = `${m.provider}/${m.id}`.toLowerCase();
      let lcp = 0;
      const n = Math.min(hay.length, q.length);
      while (lcp < n && hay[lcp] === q[lcp]) lcp++;
      let score = lcp * 10;
      for (const t of terms) if (hay.includes(t)) score += 3;
      for (const f of fragments) if (hay.includes(f)) score += 2;
      return { label: `${m.provider}/${m.id}`, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.label);
}

/** Human-facing hint shown wherever smart summaries being off matters. */
export const SUMMARY_OFF_HINT =
  "off — run /goodies summary-model <provider/model> to enable";

/** Human-facing hint shown wherever thinking summaries being off matters. */
export const THINKING_SUMMARIES_OFF_HINT =
  "off — run /goodies thinking-summaries on to enable";

const SUBCOMMANDS = [
  "list",
  "enable",
  "disable",
  "summary-model",
  "thinking-summaries",
  "recap-model",
  "recap-turns",
];

/** Subcommands that take a further argument, completed with a trailing space. */
const SUBCOMMANDS_WITH_ARGUMENT = new Set([
  "enable",
  "disable",
  "summary-model",
  "thinking-summaries",
  "recap-model",
  "recap-turns",
]);

/**
 * Argument completions for /goodies: subcommands first, then each verb's
 * values. Shared with the forced-Tab wrapper below so both paths answer from
 * one source.
 */
export function completeGoodiesArguments(
  prefix: string,
): AutocompleteItem[] | null {
  const verbMatch = prefix.match(/^(\S+)\s+(.*)$/);
  if (!verbMatch) {
    const query = prefix.trim();
    const matches = SUBCOMMANDS.filter((s) => s.startsWith(query));
    return matches.length
      ? matches.map((s) => ({
          value: SUBCOMMANDS_WITH_ARGUMENT.has(s) ? `${s} ` : s,
          label: s,
        }))
      : null;
  }
  const verb = verbMatch[1];
  const valuePrefix = verbMatch[2].trim();
  if (verb === "enable" || verb === "disable") {
    const matches = FEATURES.filter((f) => f.startsWith(valuePrefix));
    return matches.length
      ? matches.map((f) => ({ value: `${verb} ${f}`, label: f }))
      : null;
  }
  if (verb === "thinking-summaries") {
    const matches = ["on", "off"].filter((v) => v.startsWith(valuePrefix));
    return matches.length
      ? matches.map((v) => ({ value: `${verb} ${v}`, label: v }))
      : null;
  }
  if (verb === "recap-turns") {
    const matches = ["1", "2", "3", "4", "5", "default"].filter((v) =>
      v.startsWith(valuePrefix.toLowerCase()),
    );
    return matches.length
      ? matches.map((v) => ({ value: `${verb} ${v}`, label: v }))
      : null;
  }
  if (verb === "summary-model" || verb === "recap-model") {
    // Single value token (model ids contain no spaces): "off"/"default"
    // clear the setting; anything else matches the catalogue, ranked.
    // Values MUST carry the verb: pi applies a selection by replacing the
    // whole argument-text span with item.value (both its slash-argument
    // path and the forced-Tab wrapper use prefix: argumentText), so bare
    // values wipe "summary-model" off the line. enable/disable and
    // thinking-summaries already follow this pattern.
    const q = valuePrefix.toLowerCase();
    const items: AutocompleteItem[] = [];
    // "pick" opens pi's ctrl+l selector (recap-model only: summary-model
    // keeps its show-current behavior on a bare verb).
    const words =
      verb === "recap-model" ? ["pick", "off", "default"] : ["off", "default"];
    for (const w of words) {
      if (w.startsWith(q)) items.push({ value: `${verb} ${w}`, label: w });
    }
    for (const c of rankCandidates(completionModels, q).slice(0, 20)) {
      items.push({ value: `${verb} ${c}`, label: c });
    }
    return items.length ? items : null;
  }
  return null;
}

/** The argument text of a `/<command> …` line, or null outside that context. */
function commandArgumentText(
  command: string,
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): string | null {
  if (cursorLine !== 0) return null;
  const head = (lines[0] ?? "").slice(0, cursorCol);
  if (!head.startsWith(`/${command}`)) return null;
  const match = /^\s+(.*)$/.exec(head.slice(command.length + 1));
  return match ? match[1] : null;
}

/**
 * Pi's editor turns Tab in slash-command argument context into a forced file
 * completion that never consults the command's getArgumentCompletions, so Tab
 * after `/goodies enable ` would list cwd paths. Claim that context and answer
 * from the command's own completions — paths are never a valid argument of
 * these commands. Shared by /goodies and /recap.
 */
export function wrapCommandAutocomplete(
  command: string,
  complete: (argumentText: string) => AutocompleteItem[] | null,
): (current: AutocompleteProvider) => AutocompleteProvider {
  return (current) => ({
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if (options.force) {
        const argumentText = commandArgumentText(
          command,
          lines,
          cursorLine,
          cursorCol,
        );
        if (argumentText !== null) {
          const items = complete(argumentText);
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
      if (commandArgumentText(command, lines, cursorLine, cursorCol) !== null) {
        return true;
      }
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        true
      );
    },
  });
}

export const wrapGoodiesAutocomplete = wrapCommandAutocomplete(
  "goodies",
  completeGoodiesArguments,
);

let autocompleteWrapped = false;

/**
 * All catalogue models as "provider/id", stashed at session start for
 * summary-model argument completion — completion callbacks are synchronous
 * and context-free, so the registry must be captured beforehand. No auth
 * filtering: getApiKeyAndHeaders can refresh OAuth tokens, far too heavy for
 * keystrokes; a keyless pick hits the existing set-time warning instead.
 */
let completionModels: string[] = [];

export function __setCompletionModelsForTesting(models: string[]): void {
  completionModels = models;
}

/**
 * Resolve a user-typed model against the registry for a config setting.
 * Notifies and returns undefined for an unknown model; otherwise the canonical
 * "provider/id" plus whether the provider lacks auth (advisory only).
 */
function resolveConfigModel(
  ctx: {
    ui: { notify: (msg: string, level: "info" | "warning" | "error") => void };
  },
  registry: SummaryModelRegistry,
  value: string,
): { canonical: string; authMissing: boolean } | undefined {
  const found = findSummaryModel(registry, value);
  if (!found) {
    const suggestions = suggestSummaryModels(registry, value);
    ctx.ui.notify(
      `Unknown model "${value}"` +
        (suggestions.length
          ? `. Did you mean one of:\n${suggestions.map((s) => `  ${s}`).join("\n")}`
          : ". Run /models to see what your registry serves."),
      "warning",
    );
    return undefined;
  }
  return {
    canonical: `${found.provider}/${found.id}`,
    authMissing: registry.hasConfiguredAuth?.(found) === false,
  };
}

export default function goodies(pi: ExtensionAPI): void {
  // Once per extension load: session_start also fires on /new, /resume, and
  // /fork, where the first session's wrapper is still installed.
  pi.on("session_start", (_event, ctx) => {
    if (ctx.modelRegistry) {
      completionModels = ctx.modelRegistry
        .getAvailable()
        .map((m) => `${m.provider}/${m.id}`);
    }
    if (autocompleteWrapped) return;
    autocompleteWrapped = true;
    ctx.ui.addAutocompleteProvider(wrapGoodiesAutocomplete);
  });

  pi.registerCommand("goodies", {
    description: "Toggle bermudis-pi-goodies features on/off",
    getArgumentCompletions: completeGoodiesArguments,
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] || "list";

      if (sub === "list") {
        const lines = listFeatures().map(
          ({ name, enabled }) =>
            `${enabled ? "✓" : "✗"} ${name}${enabled ? "" : " (disabled)"}`,
        );
        const summaryModel = getSummaryModel();
        lines.push(
          `  smart summaries (bash): ${summaryModel ?? SUMMARY_OFF_HINT}`,
        );
        const thinkingEnabled = getThinkingSummariesEnabled();
        lines.push(
          `  thinking summaries: ${
            thinkingEnabled ? "on" : THINKING_SUMMARIES_OFF_HINT
          }` +
            (thinkingEnabled && !summaryModel
              ? " (no summary model set — run /goodies summary-model <provider/model>)"
              : ""),
        );
        const recapMinutes = getRecapIdleMinutes();
        lines.push(
          `  recap: model ${getRecapModel() ?? "session's active model"} · last ${getRecapTurns()} user messages · ${
            recapMinutes > 0 ? `${recapMinutes}m idle` : "idle off"
          } · resume ${getRecapOnResume() ? "on" : "off"}`,
        );
        ctx.ui.notify(`goodies features:\n${lines.join("\n")}`, "info");
        return;
      }

      if (sub === "enable" || sub === "disable") {
        const name = parts[1] as FeatureName | undefined;
        if (!name || !FEATURES.includes(name)) {
          ctx.ui.notify(
            `Unknown feature "${name}". Available: ${FEATURES.join(", ")}`,
            "warning",
          );
          return;
        }
        const enabled = sub === "enable";
        setEnabled(name, enabled);
        ctx.ui.notify(
          `${name} ${enabled ? "enabled" : "disabled"}. ` +
            `Run /reload or start a new session for it to take effect.`,
          "info",
        );
        return;
      }

      if (sub === "summary-model") {
        const value = parts.slice(1).join(" ");
        if (!value) {
          const current = getSummaryModel();
          ctx.ui.notify(
            current
              ? `smart summaries (bash): ${current}`
              : `smart summaries (bash): ${SUMMARY_OFF_HINT}`,
            "info",
          );
          return;
        }
        if (value === "off" || value === "default") {
          setSummaryModel(undefined);
          ctx.ui.notify(
            "summary-model cleared — smart summaries are now off",
            "info",
          );
          return;
        }
        // Validate against the user's own model registry before persisting:
        // a typo here would otherwise surface only as silent failures later.
        const registry = (
          ctx as { modelRegistry?: SummaryModelRegistry } | undefined
        )?.modelRegistry;
        if (!registry) {
          setSummaryModel(value);
          ctx.ui.notify(
            `summary-model set to ${value} (could not validate: model registry unavailable)`,
            "warning",
          );
          return;
        }
        const resolved = resolveConfigModel(ctx, registry, value);
        if (!resolved) return;
        // Store the canonical provider/id form so resolution never depends on
        // the bare-id fallback.
        const { canonical, authMissing } = resolved;
        setSummaryModel(canonical);
        ctx.ui.notify(
          `Smart summaries will use ${canonical}` +
            (authMissing
              ? "\nWarning: no auth configured for this provider yet — summaries will pause until it is."
              : ""),
          "info",
        );
        return;
      }

      if (sub === "thinking-summaries") {
        const value = parts[1];
        if (value !== "on" && value !== "off") {
          ctx.ui.notify(
            `Usage: /goodies thinking-summaries <on|off> (currently ${
              getThinkingSummariesEnabled() ? "on" : "off"
            })`,
            "warning",
          );
          return;
        }
        setThinkingSummariesEnabled(value === "on");
        const model = getSummaryModel();
        ctx.ui.notify(
          `thinking summaries ${value} (persisted). ` +
            (value === "on" && !model
              ? `No summary model set yet — run /goodies summary-model <provider/model> or nothing will happen. `
              : "") +
            "Takes effect immediately.",
          "info",
        );
        return;
      }

      if (sub === "recap-model") {
        const value = parts.slice(1).join(" ");
        const current = getRecapModel();
        const showCurrent = () =>
          ctx.ui.notify(
            `recap model: ${current ?? "the session's active model (default)"}`,
            "info",
          );
        if (value === "off" || value === "default") {
          setRecapModel(undefined);
          ctx.ui.notify(
            "recap-model cleared — recaps use the session's active model",
            "info",
          );
          return;
        }
        const registry = (
          ctx as { modelRegistry?: SummaryModelRegistry } | undefined
        )?.modelRegistry;
        let chosen: string | undefined =
          value && value !== "pick" ? value : undefined;
        if (chosen === undefined) {
          // Bare verb or "pick": pi's own ctrl+l selector. Without a UI a bare
          // verb just reports the setting.
          if (!value && !ctx.hasUI) {
            showCurrent();
            return;
          }
          const currentModel =
            current && registry
              ? findSummaryModel(registry, current)
              : undefined;
          const picked = await pickModel(ctx, {
            owner: "recap",
            title: "Recap model",
            current: currentModel,
            noUiHint: "pass the model: /goodies recap-model provider/model",
          });
          if (!picked) return; // cancelled, or already notified
          chosen = `${picked.provider}/${picked.id}`;
        }
        if (!registry) {
          setRecapModel(chosen);
          ctx.ui.notify(
            `recap-model set to ${chosen} (could not validate: model registry unavailable)`,
            "warning",
          );
          return;
        }
        const resolved = resolveConfigModel(ctx, registry, chosen);
        if (!resolved) return;
        setRecapModel(resolved.canonical);
        ctx.ui.notify(
          `Recaps will use ${resolved.canonical}` +
            (resolved.authMissing
              ? "\nWarning: no auth configured for this provider yet — recaps will fail until it is."
              : ""),
          "info",
        );
        return;
      }

      if (sub === "recap-turns") {
        const value = parts[1];
        if (value === undefined) {
          ctx.ui.notify(
            `recap reads the last ${getRecapTurns()} user messages (default ${RECAP_DEFAULT_TURNS}). Usage: /goodies recap-turns <1-${RECAP_MAX_TURNS}|default>`,
            "info",
          );
          return;
        }
        if (value === "default") {
          setRecapTurns(undefined);
          ctx.ui.notify(
            `recap-turns reset — reading the last ${RECAP_DEFAULT_TURNS} user messages`,
            "info",
          );
          return;
        }
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > RECAP_MAX_TURNS) {
          ctx.ui.notify(
            `Usage: /goodies recap-turns <1-${RECAP_MAX_TURNS}|default> (got "${value}")`,
            "warning",
          );
          return;
        }
        setRecapTurns(n);
        ctx.ui.notify(
          `recap reads the last ${n} user message${n === 1 ? "" : "s"} (and everything after the first of them). Takes effect on the next recap.`,
          "info",
        );
        return;
      }

      ctx.ui.notify(
        `Usage: /goodies [list|enable <feature>|disable <feature>|summary-model [provider/model|off]|thinking-summaries <on|off>|recap-model [provider/model|pick|off]|recap-turns <1-${RECAP_MAX_TURNS}|default>]`,
        "warning",
      );
    },
  });
}
