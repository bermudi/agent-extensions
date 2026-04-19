/**
 * optional-extension-loader-utils — pure functions for extension discovery and management.
 *
 * No filesystem operations, no Pi API dependencies. Pure data transformations
 * that are easy to test and reason about.
 */
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────

export type PackageSetting = string | {
  source?: string;
  extensions?: unknown;
  [key: string]: unknown;
};

export type SettingsFile = {
  packages?: PackageSetting[];
  extensions?: string[];
  [key: string]: unknown;
};

export type ConfigEntry = {
  name?: string;
  description?: string;
  source?: string;
  path?: string;
  paths?: string[];
};

export type ConfigFile = {
  entries?: ConfigEntry[];
};

export type OptionalEntry = {
  name: string;
  description?: string;
  sourceLabel: string;
  resolveFiles: () => string[];
};

export type PersistentMode = "startup" | "optional";
export type Scope = "global" | "project";

export type ExtensionUnit = {
  name: string;
  unitPath: string;
  entryFile: string;
};

export type PersistentItem = {
  name: string;
  mode: PersistentMode;
  scope: Scope;
  sourceLabel: string;
  kind: "package" | "settings-extension" | "auto-file" | "optional-config";
  setMode: (mode: PersistentMode) => string | undefined;
};

export type CompletionItem = { value: string; label: string };

// ─── Constants ──────────────────────────────────────────────────────

export const OPTIONAL_DIR_NAME = "optional-extensions";
export const OPTIONAL_CONFIG_NAME = "optional-extensions.json";
export const SELF_NAME = "optional-extension-loader";
export const SUPPORTED_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);

// ─── Path & Naming ──────────────────────────────────────────────────

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function resolveMaybeRelative(baseDir: string, value: string): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

export function entryNameFromPath(path: string): string {
  const ext = extname(path);
  const base = basename(path, ext);
  return base === "index" ? basename(dirname(path)) : base;
}

export function deriveNameFromSource(source: string): string {
  if (source.startsWith("npm:")) return parseNpmPackageName(source.slice(4));
  return entryNameFromPath(source);
}

export function sourceLabelForPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

// ─── File Detection ─────────────────────────────────────────────────

export function isExtensionFile(path: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(path));
}

// ─── Package Parsing ────────────────────────────────────────────────

export function parseNpmPackageName(spec: string): string {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash === -1) return spec;
    const versionAt = spec.indexOf("@", slash + 1);
    return versionAt === -1 ? spec : spec.slice(0, versionAt);
  }
  const versionAt = spec.indexOf("@");
  return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

export function packageSettingSource(pkg: PackageSetting): string | undefined {
  if (typeof pkg === "string") return pkg;
  if (pkg && typeof pkg === "object" && typeof pkg.source === "string") return pkg.source;
  return undefined;
}

export function isOptionalPackageSetting(pkg: PackageSetting): pkg is { source: string; extensions?: unknown; [key: string]: unknown } {
  return Boolean(
    pkg &&
      typeof pkg === "object" &&
      typeof pkg.source === "string" &&
      Array.isArray(pkg.extensions) &&
      pkg.extensions.length === 0,
  );
}

export function isManagedPackageSetting(pkg: PackageSetting): boolean {
  if (typeof pkg === "string") return true;
  if (!pkg || typeof pkg !== "object" || typeof pkg.source !== "string") return false;
  return !Array.isArray(pkg.extensions) || pkg.extensions.length === 0;
}

export function isPackageLikeSource(source: string): boolean {
  return (
    source.startsWith("npm:") ||
    source.startsWith("git:") ||
    source.startsWith("http://") ||
    source.startsWith("https://") ||
    source.startsWith("ssh://")
  );
}

// ─── Array Utilities ────────────────────────────────────────────────

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function removeStringFromArray(items: string[], value: string): string[] {
  return items.filter((item) => item !== value);
}

export function addUniqueString(items: string[], value: string): string[] {
  return items.includes(value) ? items : [...items, value];
}

export function findPackageIndex(packages: PackageSetting[], source: string): number {
  return packages.findIndex((pkg) => packageSettingSource(pkg) === source);
}

// ─── Lookup ─────────────────────────────────────────────────────────

export function normalizeRequestedName(input: string): string {
  return input.trim();
}

export function findEntryByName(registry: Map<string, OptionalEntry>, input: string): OptionalEntry | undefined {
  const exact = registry.get(input);
  if (exact) return exact;
  const lower = input.toLowerCase();
  return [...registry.values()].find((entry) => entry.name.toLowerCase() === lower);
}

export function findPersistentItemByName(items: PersistentItem[], input: string): PersistentItem | undefined {
  const exact = items.find((item) => item.name === input);
  if (exact) return exact;
  const lower = input.toLowerCase();
  return items.find((item) => item.name.toLowerCase() === lower);
}

// ─── Display ────────────────────────────────────────────────────────

export function formatPersistentLines(items: PersistentItem[], enabledNames: string[]): string[] {
  if (items.length === 0) {
    return [
      "No extension resources found.",
      `- Startup auto-discovery: ~/.pi/agent/extensions/ and .pi/extensions/`,
      `- Optional auto-discovery: ~/.pi/agent/${OPTIONAL_DIR_NAME}/ and .pi/${OPTIONAL_DIR_NAME}/`,
      `- Optional config file: ~/.pi/agent/${OPTIONAL_CONFIG_NAME}`,
    ];
  }

  return items
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope))
    .map((item) => {
      const loaded = item.mode === "startup" || enabledNames.includes(item.name) ? "loaded" : "not loaded";
      const autoload = item.mode === "startup" ? "autoload on" : "autoload off";
      return `[${loaded}, ${autoload}] ${item.name} (${item.scope}) — ${item.sourceLabel}`;
    });
}

// ─── Autocomplete ───────────────────────────────────────────────────

export function completeNames(names: string[], prefix: string): CompletionItem[] | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const filtered = names
    .filter((name) => normalizedPrefix.length === 0 || name.toLowerCase().startsWith(normalizedPrefix))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ value: name, label: name }));
  return filtered.length > 0 ? filtered : null;
}
