import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import createJiti from "jiti";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

type SessionStartEventLike = {
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
};

type SessionStartHandler = (event: SessionStartEventLike, ctx: ExtensionContext) => Promise<unknown> | unknown;

type PackageSetting = string | {
  source?: string;
  extensions?: unknown;
  [key: string]: unknown;
};

type SettingsFile = {
  packages?: PackageSetting[];
  extensions?: string[];
  [key: string]: unknown;
};

type ConfigEntry = {
  name?: string;
  description?: string;
  source?: string;
  path?: string;
  paths?: string[];
};

type ConfigFile = {
  entries?: ConfigEntry[];
};

type OptionalEntry = {
  name: string;
  description?: string;
  sourceLabel: string;
  resolveFiles: () => string[];
};

type PersistentMode = "startup" | "optional";
type Scope = "global" | "project";

type PersistentItem = {
  name: string;
  mode: PersistentMode;
  scope: Scope;
  sourceLabel: string;
  kind: "package" | "settings-extension" | "auto-file" | "optional-config";
  setMode: (mode: PersistentMode) => string | undefined;
};

type ExtensionUnit = {
  name: string;
  unitPath: string;
  entryFile: string;
};

const STATE_TYPE = "optional-extension-loader.state";
const STATUS_ID = "optional-exts";
const COMMAND_EXT = "ext";
const OPTIONAL_DIR_NAME = "optional-extensions";
const OPTIONAL_CONFIG_NAME = "optional-extensions.json";
const SELF_NAME = "optional-extension-loader";
const SUPPORTED_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  fsCache: false,
  interopDefault: false,
});

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function resolveMaybeRelative(baseDir: string, value: string): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function isExtensionFile(path: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(path));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function writeJson(path: string, data: unknown): void {
  ensureParentDir(path);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function safeReadJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readSettingsFile(path: string): SettingsFile {
  const parsed = safeReadJson(path);
  return parsed && typeof parsed === "object" ? (parsed as SettingsFile) : {};
}

function writeSettingsFile(path: string, data: SettingsFile): void {
  writeJson(path, data);
}

function readOptionalConfigFile(path: string): ConfigFile {
  const parsed = safeReadJson(path);
  return parsed && typeof parsed === "object" ? (parsed as ConfigFile) : { entries: [] };
}

function writeOptionalConfigFile(path: string, data: ConfigFile): void {
  const entries = Array.isArray(data.entries) ? data.entries : [];
  writeJson(path, { entries });
}

function parseNpmPackageName(spec: string): string {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash === -1) return spec;
    const versionAt = spec.indexOf("@", slash + 1);
    return versionAt === -1 ? spec : spec.slice(0, versionAt);
  }
  const versionAt = spec.indexOf("@");
  return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

let cachedGlobalNpmRoot: string | undefined;
function getGlobalNpmRoot(): string | undefined {
  if (cachedGlobalNpmRoot !== undefined) return cachedGlobalNpmRoot || undefined;
  try {
    cachedGlobalNpmRoot = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    cachedGlobalNpmRoot = "";
  }
  return cachedGlobalNpmRoot || undefined;
}

function packageSettingSource(pkg: PackageSetting): string | undefined {
  if (typeof pkg === "string") return pkg;
  if (pkg && typeof pkg === "object" && typeof pkg.source === "string") return pkg.source;
  return undefined;
}

function isOptionalPackageSetting(pkg: PackageSetting): pkg is { source: string; extensions?: unknown; [key: string]: unknown } {
  return Boolean(
    pkg &&
      typeof pkg === "object" &&
      typeof pkg.source === "string" &&
      Array.isArray(pkg.extensions) &&
      pkg.extensions.length === 0,
  );
}

function isManagedPackageSetting(pkg: PackageSetting): boolean {
  if (typeof pkg === "string") return true;
  if (!pkg || typeof pkg !== "object" || typeof pkg.source !== "string") return false;
  return !Array.isArray(pkg.extensions) || pkg.extensions.length === 0;
}

function resolvePackageSource(source: string, scopeBaseDir: string): string | undefined {
  if (source.startsWith("npm:")) {
    const packageName = parseNpmPackageName(source.slice(4));
    const projectPath = resolve(process.cwd(), ".pi/npm/node_modules", packageName);
    if (existsSync(projectPath)) return projectPath;

    const scopedGlobalRoot = resolve(getAgentDir(), "npm/node_modules", packageName);
    if (existsSync(scopedGlobalRoot)) return scopedGlobalRoot;

    const globalRoot = getGlobalNpmRoot();
    if (globalRoot) {
      const globalPath = resolve(globalRoot, packageName);
      if (existsSync(globalPath)) return globalPath;
    }
    return undefined;
  }

  if (source.startsWith("git:") || source.startsWith("http://") || source.startsWith("https://") || source.startsWith("ssh://")) {
    return undefined;
  }

  return resolveMaybeRelative(scopeBaseDir, source);
}

function discoverExtensionUnits(dir: string): ExtensionUnit[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];

  const units: ExtensionUnit[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile() && isExtensionFile(fullPath)) {
      units.push({
        name: basename(entry.name, extname(entry.name)),
        unitPath: fullPath,
        entryFile: fullPath,
      });
      continue;
    }

    if (entry.isDirectory()) {
      for (const candidate of ["index.ts", "index.js", "index.mts", "index.mjs", "index.cts", "index.cjs"]) {
        const child = join(fullPath, candidate);
        if (existsSync(child)) {
          units.push({
            name: entry.name,
            unitPath: fullPath,
            entryFile: child,
          });
          break;
        }
      }
    }
  }
  return units;
}

function resolveManifestExtensionEntries(packageRoot: string, entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const files: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.includes("*") || entry.startsWith("!")) continue;
    const resolved = resolve(packageRoot, entry);
    if (!existsSync(resolved)) continue;
    const stats = statSync(resolved);
    if (stats.isFile() && isExtensionFile(resolved)) files.push(resolved);
    else if (stats.isDirectory()) files.push(...discoverExtensionUnits(resolved).map((unit) => unit.entryFile));
  }
  return files;
}

function resolveExtensionFilesFromSourcePath(sourcePath: string): string[] {
  if (!existsSync(sourcePath)) return [];
  const stats = statSync(sourcePath);
  if (stats.isFile()) return isExtensionFile(sourcePath) ? [sourcePath] : [];
  if (!stats.isDirectory()) return [];

  const packageJsonPath = join(sourcePath, "package.json");
  const packageJson = safeReadJson(packageJsonPath) as { pi?: { extensions?: unknown } } | undefined;
  const manifestFiles = resolveManifestExtensionEntries(sourcePath, packageJson?.pi?.extensions);
  if (manifestFiles.length > 0) return unique(manifestFiles);

  const conventionalDir = join(sourcePath, "extensions");
  if (existsSync(conventionalDir)) {
    const discovered = discoverExtensionUnits(conventionalDir).map((unit) => unit.entryFile);
    if (discovered.length > 0) return unique(discovered);
  }

  for (const candidate of ["index.ts", "index.js", "index.mts", "index.mjs", "index.cts", "index.cjs"]) {
    const entry = join(sourcePath, candidate);
    if (existsSync(entry)) return [entry];
  }

  return unique(discoverExtensionUnits(sourcePath).map((unit) => unit.entryFile));
}

function entryNameFromPath(path: string): string {
  const ext = extname(path);
  const base = basename(path, ext);
  return base === "index" ? basename(dirname(path)) : base;
}

function deriveNameFromSource(source: string): string {
  if (source.startsWith("npm:")) return parseNpmPackageName(source.slice(4));
  return entryNameFromPath(source);
}

function sourceLabelForPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function isPackageLikeSource(source: string): boolean {
  return source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("http://") || source.startsWith("https://") || source.startsWith("ssh://");
}

function createOptionalDirEntries(dir: string): OptionalEntry[] {
  if (!existsSync(dir)) return [];
  return discoverExtensionUnits(dir).map((unit) => ({
    name: unit.name,
    sourceLabel: sourceLabelForPath(unit.unitPath),
    resolveFiles: () => resolveExtensionFilesFromSourcePath(unit.unitPath),
  }));
}

function createEntryFromConfig(raw: ConfigEntry, baseDir: string): OptionalEntry | undefined {
  const source = raw.source ?? raw.path;
  const name = raw.name ?? (source ? deriveNameFromSource(source) : undefined);
  if (!name) return undefined;

  if (Array.isArray(raw.paths) && raw.paths.length > 0) {
    const paths = raw.paths.map((value) => resolveMaybeRelative(baseDir, value));
    return {
      name,
      description: raw.description,
      sourceLabel: paths.map(sourceLabelForPath).join(", "),
      resolveFiles: () => paths.filter((file) => existsSync(file) && isExtensionFile(file)),
    };
  }

  if (!source) return undefined;
  return {
    name,
    description: raw.description,
    sourceLabel: source,
    resolveFiles: () => {
      const resolvedSource = resolvePackageSource(source, baseDir);
      return resolvedSource ? resolveExtensionFilesFromSourcePath(resolvedSource) : [];
    },
  };
}

function createConfigEntries(configPath: string): OptionalEntry[] {
  const parsed = readOptionalConfigFile(configPath);
  if (!Array.isArray(parsed.entries)) return [];
  const baseDir = dirname(configPath);
  return parsed.entries
    .map((entry) => createEntryFromConfig(entry, baseDir))
    .filter((entry): entry is OptionalEntry => Boolean(entry));
}

function createOptionalPackageEntriesFromSettings(settingsPath: string): OptionalEntry[] {
  const parsed = readSettingsFile(settingsPath);
  const packages = Array.isArray(parsed.packages) ? parsed.packages : [];
  const baseDir = dirname(settingsPath);

  return packages
    .filter(isOptionalPackageSetting)
    .map((pkg) => ({
      name: deriveNameFromSource(pkg.source),
      description: "Optional package extension",
      sourceLabel: pkg.source,
      resolveFiles: () => {
        const resolvedSource = resolvePackageSource(pkg.source, baseDir);
        return resolvedSource ? resolveExtensionFilesFromSourcePath(resolvedSource) : [];
      },
    }));
}

function buildOptionalRegistry(): Map<string, OptionalEntry> {
  const registry = new Map<string, OptionalEntry>();
  const globalBase = getAgentDir();
  const projectBase = resolve(process.cwd(), ".pi");

  const allEntries = [
    ...createOptionalDirEntries(join(globalBase, OPTIONAL_DIR_NAME)),
    ...createOptionalDirEntries(join(projectBase, OPTIONAL_DIR_NAME)),
    ...createConfigEntries(join(globalBase, OPTIONAL_CONFIG_NAME)),
    ...createConfigEntries(join(projectBase, OPTIONAL_CONFIG_NAME)),
    ...createOptionalPackageEntriesFromSettings(join(globalBase, "settings.json")),
    ...createOptionalPackageEntriesFromSettings(join(projectBase, "settings.json")),
  ];

  for (const entry of allEntries) registry.set(entry.name, entry);
  return registry;
}

function settingsPathForScope(scope: Scope): string {
  return scope === "global" ? join(getAgentDir(), "settings.json") : resolve(process.cwd(), ".pi/settings.json");
}

function optionalConfigPathForScope(scope: Scope): string {
  return scope === "global" ? join(getAgentDir(), OPTIONAL_CONFIG_NAME) : resolve(process.cwd(), `.pi/${OPTIONAL_CONFIG_NAME}`);
}

function startupDirForScope(scope: Scope): string {
  return scope === "global" ? join(getAgentDir(), "extensions") : resolve(process.cwd(), ".pi/extensions");
}

function optionalDirForScope(scope: Scope): string {
  return scope === "global" ? join(getAgentDir(), OPTIONAL_DIR_NAME) : resolve(process.cwd(), `.pi/${OPTIONAL_DIR_NAME}`);
}

function findPackageIndex(packages: PackageSetting[], source: string): number {
  return packages.findIndex((pkg) => packageSettingSource(pkg) === source);
}

function setPackageMode(settingsPath: string, source: string, mode: PersistentMode): string | undefined {
  const settings = readSettingsFile(settingsPath);
  const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
  const index = findPackageIndex(packages, source);
  if (index === -1) return `Package not found in ${settingsPath}: ${source}`;

  const current = packages[index]!;
  if (mode === "optional") {
    packages[index] = typeof current === "string"
      ? { source: current, extensions: [] }
      : { ...current, source, extensions: [] };
  } else {
    if (typeof current === "string") return undefined;
    const next = { ...current };
    delete next.extensions;
    packages[index] = next;
  }

  settings.packages = packages;
  writeSettingsFile(settingsPath, settings);
  return undefined;
}

function removeStringFromArray(items: string[], value: string): string[] {
  return items.filter((item) => item !== value);
}

function addUniqueString(items: string[], value: string): string[] {
  return items.includes(value) ? items : [...items, value];
}

function addConfigEntry(configPath: string, entry: ConfigEntry): void {
  const config = readOptionalConfigFile(configPath);
  const entries = Array.isArray(config.entries) ? [...config.entries] : [];
  const key = entry.path ?? entry.source;
  const existingIndex = entries.findIndex((candidate) => {
    const candidateKey = candidate.path ?? candidate.source;
    return candidate.name === entry.name && candidateKey === key;
  });
  if (existingIndex === -1) entries.push(entry);
  else entries[existingIndex] = entry;
  writeOptionalConfigFile(configPath, { entries });
}

function removeConfigEntry(configPath: string, predicate: (entry: ConfigEntry) => boolean): ConfigEntry | undefined {
  const config = readOptionalConfigFile(configPath);
  const entries = Array.isArray(config.entries) ? [...config.entries] : [];
  const index = entries.findIndex(predicate);
  if (index === -1) return undefined;
  const [removed] = entries.splice(index, 1);
  writeOptionalConfigFile(configPath, { entries });
  return removed;
}

function setSettingsExtensionMode(scope: Scope, source: string, name: string, mode: PersistentMode): string | undefined {
  const settingsPath = settingsPathForScope(scope);
  const configPath = optionalConfigPathForScope(scope);
  const settings = readSettingsFile(settingsPath);
  const extensions = Array.isArray(settings.extensions) ? [...settings.extensions] : [];

  if (mode === "optional") {
    if (!extensions.includes(source)) return `Extension path not found in ${settingsPath}: ${source}`;
    settings.extensions = removeStringFromArray(extensions, source);
    writeSettingsFile(settingsPath, settings);
    addConfigEntry(configPath, { name, path: source });
    return undefined;
  }

  const removed = removeConfigEntry(configPath, (entry) => {
    const candidate = entry.path ?? entry.source;
    return candidate === source && entry.name === name;
  });
  if (!removed) return `Optional config entry not found for ${name}`;

  settings.extensions = addUniqueString(Array.isArray(settings.extensions) ? settings.extensions : [], source);
  writeSettingsFile(settingsPath, settings);
  return undefined;
}

function setOptionalConfigEntryMode(scope: Scope, name: string, entry: ConfigEntry, mode: PersistentMode): string | undefined {
  const configPath = optionalConfigPathForScope(scope);
  const settingsPath = settingsPathForScope(scope);

  if (mode === "optional") return undefined;
  if (Array.isArray(entry.paths) && entry.paths.length !== 1) {
    return `${name} uses multiple paths; move it manually`;
  }

  const source = entry.path ?? entry.source ?? entry.paths?.[0];
  if (!source) return `Optional config entry for ${name} has no source/path`;

  const removed = removeConfigEntry(configPath, (candidate) => {
    const candidateSource = candidate.path ?? candidate.source ?? candidate.paths?.[0];
    return candidate.name === name && candidateSource === source;
  });
  if (!removed) return `Optional config entry not found for ${name}`;

  if (isPackageLikeSource(source)) {
    const settings = readSettingsFile(settingsPath);
    const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
    if (findPackageIndex(packages, source) === -1) packages.push({ source });
    settings.packages = packages;
    writeSettingsFile(settingsPath, settings);
    return undefined;
  }

  const settings = readSettingsFile(settingsPath);
  settings.extensions = addUniqueString(Array.isArray(settings.extensions) ? settings.extensions : [], source);
  writeSettingsFile(settingsPath, settings);
  return undefined;
}

function moveUnitPath(sourcePath: string, targetPath: string): string | undefined {
  ensureParentDir(targetPath);
  if (existsSync(targetPath)) return `Target already exists: ${targetPath}`;
  renameSync(sourcePath, targetPath);
  return undefined;
}

function setAutoFileMode(scope: Scope, unitPath: string, mode: PersistentMode): string | undefined {
  const currentDir = dirname(unitPath);
  const unitName = basename(unitPath);
  const startupDir = startupDirForScope(scope);
  const optionalDir = optionalDirForScope(scope);

  if (mode === "optional") {
    const target = join(optionalDir, unitName);
    return moveUnitPath(unitPath, target);
  }

  const target = join(startupDir, unitName);
  if (currentDir === dirname(target) && unitPath === target) return undefined;
  return moveUnitPath(unitPath, target);
}

function createPersistentItems(): PersistentItem[] {
  const items: PersistentItem[] = [];

  const addPackageItems = (scope: Scope) => {
    const settingsPath = settingsPathForScope(scope);
    const settings = readSettingsFile(settingsPath);
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    for (const pkg of packages) {
      if (!isManagedPackageSetting(pkg)) continue;
      const source = packageSettingSource(pkg);
      if (!source) continue;
      items.push({
        name: deriveNameFromSource(source),
        mode: isOptionalPackageSetting(pkg) ? "optional" : "startup",
        scope,
        sourceLabel: source,
        kind: "package",
        setMode: (mode) => setPackageMode(settingsPath, source, mode),
      });
    }
  };

  const addSettingsExtensionItems = (scope: Scope) => {
    const settingsPath = settingsPathForScope(scope);
    const settings = readSettingsFile(settingsPath);
    const extensions = Array.isArray(settings.extensions) ? settings.extensions : [];
    for (const extensionPath of extensions) {
      items.push({
        name: deriveNameFromSource(extensionPath),
        mode: "startup",
        scope,
        sourceLabel: extensionPath,
        kind: "settings-extension",
        setMode: (mode) => setSettingsExtensionMode(scope, extensionPath, deriveNameFromSource(extensionPath), mode),
      });
    }
  };

  const addOptionalConfigItems = (scope: Scope) => {
    const configPath = optionalConfigPathForScope(scope);
    const config = readOptionalConfigFile(configPath);
    const entries = Array.isArray(config.entries) ? config.entries : [];
    for (const entry of entries) {
      const source = entry.path ?? entry.source ?? entry.paths?.[0];
      const name = entry.name ?? (source ? deriveNameFromSource(source) : undefined);
      if (!name || !source) continue;
      if (Array.isArray(entry.paths) && entry.paths.length > 1) continue;
      items.push({
        name,
        mode: "optional",
        scope,
        sourceLabel: source,
        kind: "optional-config",
        setMode: (mode) => setOptionalConfigEntryMode(scope, name, entry, mode),
      });
    }
  };

  const addAutoDirItems = (scope: Scope, mode: PersistentMode) => {
    const dir = mode === "startup" ? startupDirForScope(scope) : optionalDirForScope(scope);
    for (const unit of discoverExtensionUnits(dir)) {
      items.push({
        name: unit.name,
        mode,
        scope,
        sourceLabel: sourceLabelForPath(unit.unitPath),
        kind: "auto-file",
        setMode: (targetMode) => setAutoFileMode(scope, unit.unitPath, targetMode),
      });
    }
  };

  addPackageItems("project");
  addPackageItems("global");
  addSettingsExtensionItems("project");
  addSettingsExtensionItems("global");
  addOptionalConfigItems("project");
  addOptionalConfigItems("global");
  addAutoDirItems("project", "startup");
  addAutoDirItems("global", "startup");
  addAutoDirItems("project", "optional");
  addAutoDirItems("global", "optional");

  const byKey = new Map<string, PersistentItem>();
  for (const item of items) byKey.set(`${item.scope}:${item.kind}:${item.name}:${item.sourceLabel}`, item);
  return [...byKey.values()];
}

function getEnabledNames(ctx: ExtensionContext): string[] {
  let enabled: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
    const next = (entry.data as { enabled?: unknown } | undefined)?.enabled;
    if (Array.isArray(next)) enabled = next.filter((value): value is string => typeof value === "string");
  }
  return unique(enabled);
}

function saveEnabledNames(pi: ExtensionAPI, names: string[]): void {
  pi.appendEntry(STATE_TYPE, { enabled: unique(names) });
}

function updateStatus(ctx: ExtensionContext, enabledNames: string[]): void {
  if (enabledNames.length === 0) {
    ctx.ui.setStatus(STATUS_ID, undefined);
    return;
  }
  const summary = enabledNames.join(", ");
  ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", `ext ${summary}`));
}

function formatPersistentLines(items: PersistentItem[], enabledNames: string[]): string[] {
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

function createPiProxy(
  pi: ExtensionAPI,
  capturedSessionStartHandlers: SessionStartHandler[],
): ExtensionAPI {
  return new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === "on") {
        return (eventName: string, handler: SessionStartHandler) => {
          if (eventName === "session_start") capturedSessionStartHandlers.push(handler);
          return target.on(eventName as never, handler as never);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExtensionAPI;
}

async function loadOptionalEntry(
  pi: ExtensionAPI,
  entry: OptionalEntry,
  event: SessionStartEventLike,
  ctx: ExtensionContext,
): Promise<string | undefined> {
  const files = unique(entry.resolveFiles());
  if (files.length === 0) {
    return `No extension files found for ${entry.name} (${entry.sourceLabel})`;
  }

  for (const file of files) {
    try {
      const mod = jiti(file);
      const factory = mod?.default ?? mod;
      if (typeof factory !== "function") {
        return `Optional extension ${entry.name} at ${file} has no default export function`;
      }

      const sessionStartHandlers: SessionStartHandler[] = [];
      const proxiedPi = createPiProxy(pi, sessionStartHandlers);
      await Promise.resolve(factory(proxiedPi));
      for (const handler of sessionStartHandlers) {
        await Promise.resolve(handler(event, ctx));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to load ${entry.name} from ${file}: ${message}`;
    }
  }

  return undefined;
}

function normalizeRequestedName(input: string): string {
  return input.trim();
}

function findEntryByName(registry: Map<string, OptionalEntry>, input: string): OptionalEntry | undefined {
  const exact = registry.get(input);
  if (exact) return exact;

  const lower = input.toLowerCase();
  return [...registry.values()].find((entry) => entry.name.toLowerCase() === lower);
}

function findPersistentItemByName(items: PersistentItem[], input: string): PersistentItem | undefined {
  const exact = items.find((item) => item.name === input);
  if (exact) return exact;

  const lower = input.toLowerCase();
  return items.find((item) => item.name.toLowerCase() === lower);
}

async function pickName(ctx: ExtensionContext, title: string, names: string[]): Promise<string | undefined> {
  if (!ctx.hasUI || names.length === 0) return undefined;
  return ctx.ui.select(title, names);
}

function completeNames(names: string[], prefix: string): AutocompleteItem[] | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const filtered = names
    .filter((name) => normalizedPrefix.length === 0 || name.toLowerCase().startsWith(normalizedPrefix))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ value: name, label: name }));
  return filtered.length > 0 ? filtered : null;
}

async function pickPersistentItem(ctx: ExtensionContext, title: string, items: PersistentItem[], enabledNames: string[]): Promise<PersistentItem | undefined> {
  if (!ctx.hasUI || items.length === 0) return undefined;
  const sorted = items.slice().sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  const labels = sorted.map((item) => {
    const loaded = item.mode === "startup" || enabledNames.includes(item.name) ? "loaded" : "not loaded";
    const autoload = item.mode === "startup" ? "autoload on" : "autoload off";
    return `${item.name} — ${loaded}, ${autoload} (${item.scope})`;
  });
  const byLabel = new Map(labels.map((label, index) => [label, sorted[index]!]));
  const selected = await ctx.ui.select(title, labels);
  return selected ? byLabel.get(selected) : undefined;
}

function getExtSubcommandCompletions(
  prefix: string,
  persistentItems: PersistentItem[],
  optionalRegistry: Map<string, OptionalEntry>,
): AutocompleteItem[] | null {
  const trimmed = prefix.trimStart();
  if (trimmed.length === 0 || !trimmed.includes(" ")) {
    const leading = trimmed.toLowerCase();
    const commands = ["list", "load", "auto"];
    const matches = commands
      .filter((command) => leading.length === 0 || command.startsWith(leading))
      .map((command) => ({ value: command, label: command }));
    return matches.length > 0 ? matches : null;
  }

  const [subcommand, ...rest] = trimmed.split(/\s+/);
  const namePrefix = rest.join(" ").trim();
  if (subcommand === "load") {
    return completeNames([...optionalRegistry.keys()], namePrefix)?.map((item) => ({
      value: `load ${item.value}`,
      label: item.label,
    })) ?? null;
  }

  if (subcommand === "auto") {
    return completeNames(
      persistentItems.filter((item) => item.name !== SELF_NAME).map((item) => item.name),
      namePrefix,
    )?.map((item) => ({
      value: `auto ${item.value}`,
      label: item.label,
    })) ?? null;
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  let optionalRegistry = buildOptionalRegistry();
  let persistentItems = createPersistentItems();

  const refreshAll = () => {
    optionalRegistry = buildOptionalRegistry();
    persistentItems = createPersistentItems();
  };

  pi.on("session_start", async (event, ctx) => {
    refreshAll();
    const enabledNames = getEnabledNames(ctx);
    updateStatus(ctx, enabledNames);

    for (const name of enabledNames) {
      const entry = optionalRegistry.get(name);
      if (!entry) {
        ctx.ui.notify(`Optional extension not found: ${name}`, "warning");
        continue;
      }
      const error = await loadOptionalEntry(pi, entry, event, ctx);
      if (error) ctx.ui.notify(error, "error");
    }
  });

  const toggleSessionLoad = async (name: string, ctx: ExtensionContext): Promise<void> => {
    refreshAll();
    const enabledNames = getEnabledNames(ctx);
    const entry = findEntryByName(optionalRegistry, name);
    if (!entry) {
      const startupItem = findPersistentItemByName(persistentItems, name);
      if (startupItem?.mode === "startup") {
        ctx.ui.notify(`${startupItem.name} already loads automatically at startup`, "info");
        return;
      }
      ctx.ui.notify(`Unknown optional extension: ${name}`, "error");
      return;
    }

    if (enabledNames.includes(entry.name)) {
      saveEnabledNames(
        pi,
        enabledNames.filter((itemName) => itemName !== entry.name),
      );
      ctx.ui.notify(`Unloading ${entry.name} from this session…`, "info");
    } else {
      saveEnabledNames(pi, [...enabledNames, entry.name]);
      ctx.ui.notify(`Loading ${entry.name} for this session…`, "info");
    }
    await ctx.reload();
  };

  const toggleAutoload = async (name: string, ctx: ExtensionContext): Promise<void> => {
    refreshAll();
    const enabledNames = getEnabledNames(ctx);
    const item = findPersistentItemByName(
      persistentItems.filter((candidate) => candidate.name !== SELF_NAME || candidate.mode === "optional"),
      name,
    );
    if (!item) {
      ctx.ui.notify(`Unknown extension: ${name}`, "error");
      return;
    }
    if (item.name === SELF_NAME && item.mode === "startup") {
      ctx.ui.notify(`Refusing to disable autoload for ${SELF_NAME} from inside itself`, "error");
      return;
    }

    const nextMode: PersistentMode = item.mode === "startup" ? "optional" : "startup";
    const error = item.setMode(nextMode);
    if (error) {
      ctx.ui.notify(error, "error");
      return;
    }

    if (nextMode === "optional") {
      saveEnabledNames(pi, [...enabledNames, item.name]);
      ctx.ui.notify(`${item.name} will stop autoloading and stay loaded in this session`, "success");
    } else {
      saveEnabledNames(
        pi,
        enabledNames.filter((itemName) => itemName !== item.name),
      );
      ctx.ui.notify(`${item.name} will autoload again`, "success");
    }
    await ctx.reload();
  };

  const showManager = async (ctx: ExtensionContext): Promise<void> => {
    refreshAll();
    const enabledNames = getEnabledNames(ctx);
    const item = await pickPersistentItem(
      ctx,
      "Extensions",
      persistentItems.filter((candidate) => candidate.name !== SELF_NAME || candidate.mode === "optional"),
      enabledNames,
    );
    if (!item) return;

    const actions: string[] = [];
    const loadedNow = item.mode === "startup" || enabledNames.includes(item.name);
    if (item.mode === "optional") {
      actions.push(loadedNow ? "Toggle load for this session (currently loaded)" : "Toggle load for this session (currently not loaded)");
    }
    actions.push(item.mode === "startup" ? "Toggle autoload (currently on)" : "Toggle autoload (currently off)");
    actions.push("Cancel");

    const choice = await ctx.ui.select(`${item.name} — choose action`, actions);
    if (!choice || choice === "Cancel") return;
    if (choice.startsWith("Toggle load")) {
      await toggleSessionLoad(item.name, ctx);
      return;
    }
    await toggleAutoload(item.name, ctx);
  };

  pi.registerCommand(COMMAND_EXT, {
    description: "Manage session loading and autoload for extensions",
    getArgumentCompletions: (prefix) => {
      refreshAll();
      return getExtSubcommandCompletions(prefix, persistentItems, optionalRegistry);
    },
    handler: async (args, ctx) => {
      const requested = normalizeRequestedName(args ?? "");
      if (!requested) {
        if (!ctx.hasUI) {
          refreshAll();
          const enabledNames = getEnabledNames(ctx);
          ctx.ui.notify(formatPersistentLines(persistentItems, enabledNames).join("\n"), "info");
          return;
        }
        await showManager(ctx);
        return;
      }

      const [subcommand, ...rest] = requested.split(/\s+/);
      const target = rest.join(" ").trim();

      if (subcommand === "list") {
        refreshAll();
        const enabledNames = getEnabledNames(ctx);
        ctx.ui.notify(formatPersistentLines(persistentItems, enabledNames).join("\n"), "info");
        return;
      }

      if (subcommand === "load") {
        if (!target) {
          refreshAll();
          const enabledNames = getEnabledNames(ctx);
          const choices = [...optionalRegistry.keys()].filter((name) => true).sort();
          const chosen = await pickName(ctx, "Toggle load for optional extension", choices);
          if (!chosen) return;
          await toggleSessionLoad(chosen, ctx);
          return;
        }
        await toggleSessionLoad(target, ctx);
        return;
      }

      if (subcommand === "auto") {
        if (!target) {
          refreshAll();
          const enabledNames = getEnabledNames(ctx);
          const item = await pickPersistentItem(
            ctx,
            "Toggle extension autoload",
            persistentItems.filter((candidate) => candidate.name !== SELF_NAME || candidate.mode === "optional"),
            enabledNames,
          );
          if (!item) return;
          await toggleAutoload(item.name, ctx);
          return;
        }
        await toggleAutoload(target, ctx);
        return;
      }

      const directItem = findPersistentItemByName(persistentItems, requested);
      if (directItem && ctx.hasUI) {
        await showManager(ctx);
        return;
      }

      ctx.ui.notify(`Usage: /${COMMAND_EXT} [list | load <name> | auto <name>]`, "info");
    },
  });
}
