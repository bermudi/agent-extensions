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
 * The only exception is `summary-model`, which is read at request time.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { reportFailure } from "./goodies-log.ts";
import { writeJsonFileAtomic, describeError } from "./json-file.ts";

let CONFIG_PATH = join(homedir(), ".pi", "agent", "goodies.json");

export function __setConfigPathForTesting(path: string): void {
  CONFIG_PATH = path;
  config = loadConfig();
}

type FeatureName =
  | "copy-with-model"
  | "copy-trajectory"
  | "name-with-ai"
  | "zed"
  | "prefer-tools"
  | "keep-model"
  | "model-thinking"
  | "clean-tui"
  | "review"
  | "kilo"
  | "provider-balance"
  | "tps";

const FEATURES: FeatureName[] = [
  "copy-with-model",
  "copy-trajectory",
  "name-with-ai",
  "zed",
  "prefer-tools",
  "keep-model",
  "model-thinking",
  "clean-tui",
  "review",
  "kilo",
  "provider-balance",
  "tps",
];

type Config = Partial<Record<FeatureName, boolean>> & {
  /**
   * Model ("provider/id") clean-tui uses for AI command summaries, resolved
   * through the user's own pi model registry (its providers and auth).
   * Unset means the feature is off.
   */
  "summary-model"?: string;
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

export function isEnabled(name: FeatureName): boolean {
  return config[name] !== false; // default true
}

export function setEnabled(name: FeatureName, enabled: boolean): void {
  config[name] = enabled;
  saveConfig(config);
}

export function listFeatures(): Array<{ name: FeatureName; enabled: boolean }> {
  return FEATURES.map((name) => ({ name, enabled: isEnabled(name) }));
}

export function getSummaryModel(): string | undefined {
  const v = config["summary-model"];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function setSummaryModel(model: string | undefined): void {
  if (model === undefined || model.trim() === "") {
    delete config["summary-model"];
  } else {
    config["summary-model"] = model.trim();
  }
  saveConfig(config);
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

export default function goodies(pi: ExtensionAPI): void {
  pi.registerCommand("goodies", {
    description: "Toggle bermudis-pi-goodies features on/off",
    getArgumentCompletions: (prefix) => {
      const subcommands = ["list", "enable", "disable", "summary-model"];
      const verbMatch = prefix.match(/^(\S+)\s+(.*)$/);
      if (verbMatch) {
        const verb = verbMatch[1];
        const featurePrefix = verbMatch[2].trim();
        if (["enable", "disable"].includes(verb)) {
          return FEATURES.filter((f) => f.startsWith(featurePrefix)).map(
            (f) => ({ value: `${verb} ${f}`, label: f }),
          );
        }
        return null;
      }
      const firstWord = prefix.trim();
      return subcommands
        .filter((s) => s.startsWith(firstWord))
        .map((s) => ({ value: s, label: s }));
    },
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
          return;
        }
        // Store the canonical provider/id form so resolution never depends on
        // the bare-id fallback.
        const canonical = `${found.provider}/${found.id}`;
        setSummaryModel(canonical);
        const authMissing = registry.hasConfiguredAuth?.(found) === false;
        ctx.ui.notify(
          `Smart summaries will use ${canonical}` +
            (authMissing
              ? "\nWarning: no auth configured for this provider yet — summaries will pause until it is."
              : ""),
          "info",
        );
        return;
      }

      ctx.ui.notify(
        `Usage: /goodies [list|enable <feature>|disable <feature>|summary-model [provider/model|off]]`,
        "warning",
      );
    },
  });
}
