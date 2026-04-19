/**
 * extension-manager-utils — pure functions for extension management.
 *
 * No filesystem mutations, no Pi API dependencies. Pure data transformations
 * and path/naming utilities.
 */
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────

export type Scope = "global" | "project";
export type ExtensionKind = "local-file" | "local-dir" | "git" | "npm";

export interface ExtensionSource {
  /** Human-readable source identifier */
  label: string;
  /** What kind of source this is */
  kind: ExtensionKind;
  /** For git sources: the repo URL */
  gitUrl?: string;
  /** For npm sources: the package name */
  npmPackage?: string;
  /** Local path (resolved) */
  localPath?: string;
}

export interface ExtensionEntry {
  /** Unique name for this extension */
  name: string;
  /** Description (from manifest or derived) */
  description?: string;
  /** Where this extension comes from */
  source: ExtensionSource;
  /** Whether it loads automatically at startup */
  autoload: boolean;
  /** Scope (global or project) */
  scope: Scope;
  /** Resolved entry file(s) */
  resolveFiles: () => string[];
}

export interface ManagedExtension {
  name: string;
  source: ExtensionSource;
  autoload: boolean;
  scope: Scope;
  /** Version/tag/commit if available */
  version?: string;
  /** When it was installed */
  installedAt?: string;
  /** Path to installed copy (for git/npm) */
  installPath?: string;
}

export type AutocompleteItem = { value: string; label: string };

// ─── Constants ──────────────────────────────────────────────────────

export const AGENT_EXTENSIONS_DIR = "extensions";
export const AGENT_OPTIONAL_DIR = "optional-extensions";
export const MANAGER_CONFIG_NAME = "extension-manager.json";
export const SELF_NAME = "extension-manager";
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
  if (source.startsWith("git:")) {
    // git:github.com/user/repo → repo
    const parts = source.replace(/^git:/, "").split("/");
    return parts[parts.length - 1]?.replace(/\.git$/, "") ?? source;
  }
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

export function isPackageLikeSource(source: string): boolean {
  return (
    source.startsWith("npm:") ||
    source.startsWith("git:") ||
    source.startsWith("http://") ||
    source.startsWith("https://") ||
    source.startsWith("ssh://")
  );
}

export function classifySource(source: string): ExtensionKind {
  if (source.startsWith("git:") || source.startsWith("https://github.com") || source.startsWith("ssh://")) return "git";
  if (source.startsWith("npm:")) return "npm";
  return "local-file";
}

export function buildSourceInfo(source: string): ExtensionSource {
  const kind = classifySource(source);
  const label = source;
  const info: ExtensionSource = { label, kind };

  if (kind === "git") {
    info.gitUrl = source.replace(/^git:/, "https://");
  } else if (kind === "npm") {
    info.npmPackage = parseNpmPackageName(source.slice(4));
  } else {
    info.localPath = source;
  }

  return info;
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

// ─── Autocomplete ───────────────────────────────────────────────────

export function completeNames(names: string[], prefix: string): AutocompleteItem[] | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const filtered = names
    .filter((name) => normalizedPrefix.length === 0 || name.toLowerCase().startsWith(normalizedPrefix))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ value: name, label: name }));
  return filtered.length > 0 ? filtered : null;
}

// ─── Display ────────────────────────────────────────────────────────

export function formatExtensionLines(entries: ExtensionEntry[]): string[] {
  if (entries.length === 0) {
    return ["No extensions found.", "Use /ext install <source> to add one."];
  }

  return entries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope))
    .map((entry) => {
      const load = entry.autoload ? "autoload" : "manual";
      const source = entry.source.label;
      return `[${load}] ${entry.name} (${entry.scope}) — ${source}`;
    });
}

// ─── Git URL helpers ────────────────────────────────────────────────

export function gitUrlToDirName(url: string): string {
  // git:github.com/user/repo → github.com/user/repo
  const cleaned = url
    .replace(/^git:/, "")
    .replace(/^https:\/\//, "")
    .replace(/^ssh:\/\/git@/, "")
    .replace(/\.git$/, "");
  return cleaned;
}

export function gitUrlToHttps(url: string): string {
  if (url.startsWith("git:")) return `https://${url.slice(4)}`;
  if (url.startsWith("ssh://git@")) return `https://${url.slice("ssh://git@".length)}`;
  return url;
}
