import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import createJiti from "jiti";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import {
  type ExtensionEntry,
  type ManagedExtension,
  type ExtensionSource,
  type Scope,
  type ExtensionKind,
  AGENT_EXTENSIONS_DIR,
  MANAGER_CONFIG_NAME,
  SELF_NAME,
  SUPPORTED_EXTENSIONS,
  expandHome,
  resolveMaybeRelative,
  isExtensionFile,
  unique,
  classifySource,
  buildSourceInfo,
  deriveNameFromSource,
  sourceLabelForPath,
  entryNameFromPath,
  gitUrlToDirName,
  gitUrlToHttps,
  completeNames,
  formatExtensionLines,
} from "./extension-manager-utils.js";

// ─── Types ──────────────────────────────────────────────────────────

type SessionStartEventLike = {
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
};

type SessionStartHandler = (event: SessionStartEventLike, ctx: ExtensionContext) => Promise<unknown> | unknown;

const STATE_TYPE = "extension-manager.state";
const STATUS_ID = "ext-mgr";
const COMMAND_EXT = "ext";

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  fsCache: false,
  interopDefault: false,
});

// ─── Filesystem helpers ─────────────────────────────────────────────

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, data: unknown): void {
  ensureDir(dirname(path));
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

// ─── Manager config ─────────────────────────────────────────────────

interface ManagerConfig {
  extensions: ManagedExtension[];
}

function configPath(): string {
  return join(getAgentDir(), MANAGER_CONFIG_NAME);
}

function readConfig(): ManagerConfig {
  const data = safeReadJson(configPath());
  if (data && typeof data === "object" && Array.isArray((data as ManagerConfig).extensions)) {
    return data as ManagerConfig;
  }
  return { extensions: [] };
}

function writeConfig(config: ManagerConfig): void {
  writeJson(configPath(), config);
}

// ─── Extension discovery ────────────────────────────────────────────

interface ExtensionUnit {
  name: string;
  unitPath: string;
  entryFile: string;
}

function discoverUnits(dir: string): ExtensionUnit[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];

  const units: ExtensionUnit[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(fullPath)) {
      units.push({
        name: basename(entry.name, extname(fullPath)),
        unitPath: fullPath,
        entryFile: fullPath,
      });
      continue;
    }

    if (entry.isDirectory() || entry.isSymbolicLink()) {
      // Check for index file
      for (const candidate of ["index.ts", "index.js", "index.mts", "index.mjs"]) {
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

function resolveExtensionFilesFromPath(sourcePath: string): string[] {
  if (!existsSync(sourcePath)) return [];
  const stats = statSync(sourcePath);
  if (stats.isFile()) return isExtensionFile(sourcePath) ? [sourcePath] : [];
  if (!stats.isDirectory()) return [];

  // Check for package.json manifest
  const pkgJson = safeReadJson(join(sourcePath, "package.json")) as { pi?: { extensions?: unknown } } | undefined;
  if (pkgJson?.pi?.extensions && Array.isArray(pkgJson.pi.extensions)) {
    const files: string[] = [];
    for (const entry of pkgJson.pi.extensions) {
      if (typeof entry !== "string") continue;
      const resolved = resolve(sourcePath, entry);
      if (!existsSync(resolved)) continue;
      const s = statSync(resolved);
      if (s.isFile() && isExtensionFile(resolved)) files.push(resolved);
      else if (s.isDirectory()) files.push(...discoverUnits(resolved).map((u) => u.entryFile));
    }
    if (files.length > 0) return unique(files);
  }

  // Check conventional extensions/ dir
  const convDir = join(sourcePath, "extensions");
  if (existsSync(convDir) && statSync(convDir).isDirectory()) {
    const discovered = discoverUnits(convDir);
    if (discovered.length > 0) return unique(discovered.map((u) => u.entryFile));
  }

  // Check for index file
  for (const candidate of ["index.ts", "index.js", "index.mts", "index.mjs"]) {
    const entry = join(sourcePath, candidate);
    if (existsSync(entry)) return [entry];
  }

  // Fall back to discovering all files in dir
  return unique(discoverUnits(sourcePath).map((u) => u.entryFile));
}

// ─── Registry building ──────────────────────────────────────────────

function getGlobalExtensionsDir(): string {
  return join(getAgentDir(), AGENT_EXTENSIONS_DIR);
}

function getGlobalOptionalDir(): string {
  return join(getAgentDir(), "optional-extensions");
}

function getProjectExtensionsDir(): string {
  return resolve(process.cwd(), ".pi/extensions");
}

function getProjectOptionalDir(): string {
  return resolve(process.cwd(), ".pi/optional-extensions");
}

function buildRegistry(): ExtensionEntry[] {
  const entries: ExtensionEntry[] = [];
  const seen = new Set<string>();

  const addDir = (dir: string, autoload: boolean, scope: Scope) => {
    for (const unit of discoverUnits(dir)) {
      if (seen.has(unit.name)) continue;
      seen.add(unit.name);
      entries.push({
        name: unit.name,
        source: {
          label: sourceLabelForPath(unit.unitPath),
          kind: classifySource(unit.unitPath),
          localPath: unit.unitPath,
        },
        autoload,
        scope,
        resolveFiles: () => resolveExtensionFilesFromPath(unit.unitPath),
      });
    }
  };

  // Auto-discovered from extensions/ dirs
  addDir(getGlobalExtensionsDir(), true, "global");
  addDir(getProjectExtensionsDir(), true, "project");

  // Managed extensions from config
  const config = readConfig();
  for (const ext of config.extensions) {
    if (seen.has(ext.name)) continue;
    seen.add(ext.name);

    let resolveFiles: () => string[];
    if (ext.installPath && existsSync(ext.installPath)) {
      resolveFiles = () => resolveExtensionFilesFromPath(ext.installPath!);
    } else if (ext.source.localPath && existsSync(ext.source.localPath)) {
      resolveFiles = () => resolveExtensionFilesFromPath(ext.source.localPath!);
    } else {
      resolveFiles = () => [];
    }

    entries.push({
      name: ext.name,
      source: ext.source,
      autoload: ext.autoload,
      scope: ext.scope,
      resolveFiles,
    });
  }

  // Optional auto-discovered
  addDir(getGlobalOptionalDir(), false, "global");
  addDir(getProjectOptionalDir(), false, "project");

  return entries;
}

// ─── Install / Uninstall ────────────────────────────────────────────

function getGitInstallDir(url: string): string {
  // Install under ~/.pi/agent/git/<host>/<user>/<repo>
  const dirName = gitUrlToDirName(url);
  return join(getAgentDir(), "git", dirName);
}

function getNpmInstallDir(packageName: string): string {
  return join(getAgentDir(), "npm", packageName);
}

function installGitExtension(url: string, name?: string): { path: string; name: string } | { error: string } {
  const installDir = getGitInstallDir(url);

  // Clone or pull
  if (existsSync(installDir)) {
    try {
      execSync("git pull --ff-only", { cwd: installDir, stdio: "pipe" });
    } catch (e) {
      return { error: `git pull failed for ${url}: ${e instanceof Error ? e.message : String(e)}` };
    }
  } else {
    try {
      const httpsUrl = gitUrlToHttps(url);
      execSync(`git clone ${httpsUrl} ${installDir}`, { stdio: "pipe" });
    } catch (e) {
      return { error: `git clone failed for ${url}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const derivedName = name ?? deriveNameFromSource(`git:${gitUrlToDirName(url)}`);
  return { path: installDir, name: derivedName };
}

function installNpmExtension(packageSpec: string, name?: string): { path: string; name: string } | { error: string } {
  const packageName = deriveNameFromSource(`npm:${packageSpec}`);
  const derivedName = name ?? packageName;

  try {
    const agentDir = getAgentDir();
    ensureDir(join(agentDir, "npm"));
    execSync(`npm install --prefix ${join(agentDir, "npm")} ${packageSpec}`, { stdio: "pipe" });

    const installDir = join(agentDir, "npm", "node_modules", packageName);
    if (!existsSync(installDir)) {
      return { error: `npm install succeeded but module not found at ${installDir}` };
    }

    return { path: installDir, name: derivedName };
  } catch (e) {
    return { error: `npm install failed for ${packageSpec}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function installLocalExtension(localPath: string, name?: string): { path: string; name: string } | { error: string } {
  const resolved = resolveMaybeRelative(process.cwd(), localPath);
  if (!existsSync(resolved)) {
    return { error: `Path does not exist: ${resolved}` };
  }

  const derivedName = name ?? entryNameFromPath(resolved);
  return { path: resolved, name: derivedName };
}

function addManagedExtension(ext: ManagedExtension): void {
  const config = readConfig();
  const existing = config.extensions.findIndex((e) => e.name === ext.name);
  if (existing !== -1) {
    config.extensions[existing] = ext;
  } else {
    config.extensions.push(ext);
  }
  writeConfig(config);
}

function removeManagedExtension(name: string): ManagedExtension | undefined {
  const config = readConfig();
  const index = config.extensions.findIndex((e) => e.name === name);
  if (index === -1) return undefined;
  const [removed] = config.extensions.splice(index, 1);
  writeConfig(config);
  return removed;
}

function uninstallFiles(ext: ManagedExtension): string | undefined {
  if (ext.installPath && existsSync(ext.installPath)) {
    // Don't remove git clones that are in the standard git dir — they might be
    // managed by pi's own package system. Only remove things we installed.
    const gitBase = join(getAgentDir(), "git");
    const npmBase = join(getAgentDir(), "npm");
    if (ext.installPath.startsWith(gitBase) || ext.installPath.startsWith(npmBase)) {
      try {
        rmSync(ext.installPath, { recursive: true, force: true });
      } catch (e) {
        return `Failed to remove ${ext.installPath}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }
  return undefined;
}

// ─── Update ─────────────────────────────────────────────────────────

function pullUpdate(ext: ManagedExtension): string | undefined {
  if (!ext.installPath || !existsSync(ext.installPath)) {
    return `Install path not found: ${ext.installPath ?? "(none)"}`;
  }

  const kind = ext.source.kind;
  if (kind === "git") {
    try {
      const result = execSync("git pull --ff-only", {
        cwd: ext.installPath,
        encoding: "utf8",
        stdio: "pipe",
      });
      return result.trim() || "Already up to date.";
    } catch (e) {
      return `git pull failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (kind === "npm" && ext.source.npmPackage) {
    try {
      const agentDir = getAgentDir();
      execSync(`npm update --prefix ${join(agentDir, "npm")} ${ext.source.npmPackage}`, { stdio: "pipe" });
      return "Updated.";
    } catch (e) {
      return `npm update failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return `Cannot update ${kind} extension in-place.`;
}

// ─── Session state (for session-only loading) ───────────────────────

function sessionStatePath(ctx: ExtensionContext): string | undefined {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return undefined;
  return join(dirname(sessionFile), "ext-manager-session-state.json");
}

function getEnabledNames(ctx: ExtensionContext): string[] {
  const sidecarPath = sessionStatePath(ctx);
  if (sidecarPath) {
    const data = safeReadJson(sidecarPath) as { enabled?: unknown } | undefined;
    if (data && Array.isArray(data.enabled)) {
      return unique(data.enabled.filter((v): v is string => typeof v === "string"));
    }
  }

  // Fallback: check session entries
  let enabled: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
    const next = (entry.data as { enabled?: unknown } | undefined)?.enabled;
    if (Array.isArray(next)) enabled = next.filter((value): value is string => typeof value === "string");
  }
  return unique(enabled);
}

function saveEnabledNames(ctx: ExtensionContext, pi: ExtensionAPI, names: string[]): void {
  const sidecarPath = sessionStatePath(ctx);
  if (sidecarPath) {
    writeJson(sidecarPath, { enabled: unique(names) });
  }
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

// ─── Optional extension loading ─────────────────────────────────────

function createPiProxy(pi: ExtensionAPI, capturedSessionStartHandlers: SessionStartHandler[]): ExtensionAPI {
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

async function loadExtension(
  pi: ExtensionAPI,
  entry: ExtensionEntry,
  event: SessionStartEventLike,
  ctx: ExtensionContext,
): Promise<string | undefined> {
  const files = unique(entry.resolveFiles());
  if (files.length === 0) {
    return `No extension files found for ${entry.name} (${entry.source.label})`;
  }

  for (const file of files) {
    try {
      const mod = jiti(file);
      const factory = mod?.default ?? mod;
      if (typeof factory !== "function") {
        return `Extension ${entry.name} at ${file} has no default export function`;
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

// ─── TUI helpers ────────────────────────────────────────────────────

async function pickName(ctx: ExtensionContext, title: string, names: string[]): Promise<string | undefined> {
  if (!ctx.hasUI || names.length === 0) return undefined;
  return ctx.ui.select(title, names);
}

// ─── Autocomplete ───────────────────────────────────────────────────

function getCompletions(
  prefix: string,
  registry: ExtensionEntry[],
  config: ManagedExtension[],
): AutocompleteItem[] | null {
  const trimmed = prefix.trimStart();
  const parts = trimmed.split(/\s+/);

  // Complete subcommand
  if (parts.length <= 1) {
    const leading = (parts[0] ?? "").toLowerCase();
    const commands = ["list", "install", "uninstall", "update", "load", "autoload"];
    const matches = commands
      .filter((cmd) => leading.length === 0 || cmd.startsWith(leading))
      .map((cmd) => ({ value: cmd, label: cmd }));
    return matches.length > 0 ? matches : null;
  }

  const [subcommand] = parts;
  const namePrefix = parts.slice(1).join(" ").trim();

  if (subcommand === "load" || subcommand === "uninstall" || subcommand === "update" || subcommand === "autoload") {
    const names = registry.map((e) => e.name);
    return completeNames(names, namePrefix);
  }

  return null;
}

// ─── Extension entry point ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let registry = buildRegistry();

  const refresh = () => {
    registry = buildRegistry();
  };

  // Load session-only extensions on session start
  pi.on("session_start", async (event, ctx) => {
    refresh();
    const enabledNames = getEnabledNames(ctx);
    updateStatus(ctx, enabledNames);

    for (const name of enabledNames) {
      const entry = registry.find((e) => e.name === name);
      if (!entry) {
        ctx.ui.notify(`Session extension not found: ${name}`, "warning");
        continue;
      }
      const error = await loadExtension(pi, entry, event, ctx);
      if (error) ctx.ui.notify(error, "error");
    }
  });

  // ─── Install handler ────────────────────────────────────────────

  const handleInstall = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const source = args.trim();
    if (!source) {
      ctx.ui.notify("Usage: /ext install <git-url | npm:package | local-path> [--name name]", "info");
      return;
    }

    // Parse optional --name flag
    let name: string | undefined;
    let cleanSource = source;
    const nameMatch = source.match(/--name\s+(\S+)/);
    if (nameMatch) {
      name = nameMatch[1];
      cleanSource = source.replace(/--name\s+\S+/, "").trim();
    }

    const kind = classifySource(cleanSource);
    let result: { path: string; name: string } | { error: string };

    if (kind === "git") {
      result = installGitExtension(cleanSource, name);
    } else if (kind === "npm") {
      result = installNpmExtension(cleanSource.slice(4), name);
    } else {
      result = installLocalExtension(cleanSource, name);
    }

    if ("error" in result) {
      ctx.ui.notify(result.error, "error");
      return;
    }

    // Check that the installed extension has loadable files
    const files = resolveExtensionFilesFromPath(result.path);
    if (files.length === 0) {
      ctx.ui.notify(`No extension files found at ${result.path}`, "error");
      return;
    }

    // Create symlink in extensions dir for auto-discovery
    const extDir = getGlobalExtensionsDir();
    ensureDir(extDir);
    const symlinkPath = join(extDir, `${result.name}.ts`);

    // If it's a directory extension, symlink the directory
    const targetStat = statSync(result.path);
    if (targetStat.isDirectory()) {
      // Create symlink to directory
      if (existsSync(symlinkPath) || lstatSync(symlinkPath.replace(".ts", "")).isDirectory()) {
        // Already exists as symlink to file - check
      }
      const dirSymlink = join(extDir, result.name);
      if (!existsSync(dirSymlink)) {
        ensureDir(dirname(dirSymlink));
        // Use relative symlink for portability
        const { symlink } = await import("node:fs/promises");
        await symlink(result.path, dirSymlink, "junction");
      }
    } else {
      // Single file extension
      if (!existsSync(symlinkPath)) {
        const { symlink } = await import("node:fs/promises");
        await symlink(result.path, symlinkPath, "file");
      }
    }

    // Save to managed config
    const managed: ManagedExtension = {
      name: result.name,
      source: buildSourceInfo(cleanSource),
      autoload: true,
      scope: "global",
      version: kind === "git" ? "latest" : undefined,
      installedAt: new Date().toISOString(),
      installPath: result.path,
    };
    addManagedExtension(managed);

    ctx.ui.notify(`Installed ${result.name} from ${cleanSource}`, "success");
    await ctx.reload();
  };

  // ─── Uninstall handler ──────────────────────────────────────────

  const handleUninstall = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const name = args.trim();
    if (!name) {
      const config = readConfig();
      const choices = config.extensions.map((e) => `${e.name} (${e.source.label})`);
      if (choices.length === 0) {
        ctx.ui.notify("No managed extensions to uninstall.", "info");
        return;
      }
      const chosen = await pickName(ctx, "Uninstall extension", choices);
      if (!chosen) return;
      const target = config.extensions.find((e) => `${e.name} (${e.source.label})` === chosen);
      if (!target) return;
      await doUninstall(target.name, ctx);
      return;
    }

    await doUninstall(name, ctx);
  };

  const doUninstall = async (name: string, ctx: ExtensionContext): Promise<void> => {
    if (name === SELF_NAME) {
      ctx.ui.notify("Cannot uninstall the extension manager from itself.", "error");
      return;
    }

    const ext = removeManagedExtension(name);
    if (!ext) {
      // Also try removing from auto-discovered dirs
      const extDir = getGlobalExtensionsDir();
      const filePath = join(extDir, `${name}.ts`);
      const dirPath = join(extDir, name);

      let removed = false;
      if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
        rmSync(filePath);
        removed = true;
      }
      if (existsSync(dirPath) && lstatSync(dirPath).isSymbolicLink()) {
        rmSync(dirPath, { recursive: true, force: true });
        removed = true;
      }

      if (removed) {
        ctx.ui.notify(`Removed ${name} symlink.`, "success");
        await ctx.reload();
      } else {
        ctx.ui.notify(`Extension not found: ${name}`, "error");
      }
      return;
    }

    // Remove symlink
    const extDir = getGlobalExtensionsDir();
    const filePath = join(extDir, `${name}.ts`);
    const dirPath = join(extDir, name);
    if (existsSync(filePath)) rmSync(filePath);
    if (existsSync(dirPath)) rmSync(dirPath, { recursive: true, force: true });

    // Remove installed files (if managed by us)
    const error = uninstallFiles(ext);
    if (error) {
      ctx.ui.notify(error, "warning");
    }

    ctx.ui.notify(`Uninstalled ${name}`, "success");
    await ctx.reload();
  };

  // ─── Update handler ─────────────────────────────────────────────

  const handleUpdate = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const name = args.trim();
    const config = readConfig();

    if (!name) {
      // Update all managed git/npm extensions
      const updatable = config.extensions.filter((e) => e.source.kind === "git" || e.source.kind === "npm");
      if (updatable.length === 0) {
        ctx.ui.notify("No updatable extensions found.", "info");
        return;
      }

      const results: string[] = [];
      for (const ext of updatable) {
        const result = pullUpdate(ext);
        results.push(`${ext.name}: ${result ?? "Updated."}`);
      }
      ctx.ui.notify(results.join("\n"), "info");
      await ctx.reload();
      return;
    }

    const ext = config.extensions.find((e) => e.name === name);
    if (!ext) {
      ctx.ui.notify(`Managed extension not found: ${name}`, "error");
      return;
    }

    const result = pullUpdate(ext);
    if (result) {
      ctx.ui.notify(`${name}: ${result}`, result.includes("fail") || result.includes("error") ? "error" : "info");
    } else {
      ctx.ui.notify(`${name}: Updated.`, "success");
    }
    await ctx.reload();
  };

  // ─── Load handler (session-only) ────────────────────────────────

  const handleLoad = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const name = args.trim();
    if (!name) {
      const nonAutoload = registry.filter((e) => !e.autoload);
      const choices = nonAutoload.map((e) => e.name);
      if (choices.length === 0) {
        ctx.ui.notify("No optional extensions to load.", "info");
        return;
      }
      const chosen = await pickName(ctx, "Load extension for this session", choices);
      if (!chosen) return;
      await doLoad(chosen, ctx);
      return;
    }
    await doLoad(name, ctx);
  };

  const doLoad = async (name: string, ctx: ExtensionContext): Promise<void> => {
    refresh();
    const enabledNames = getEnabledNames(ctx);
    const entry = registry.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (!entry) {
      ctx.ui.notify(`Unknown extension: ${name}`, "error");
      return;
    }

    if (entry.autoload) {
      ctx.ui.notify(`${entry.name} already loads automatically.`, "info");
      return;
    }

    if (enabledNames.includes(entry.name)) {
      // Toggle off
      saveEnabledNames(ctx, pi, enabledNames.filter((n) => n !== entry.name));
      ctx.ui.notify(`Unloading ${entry.name} from this session…`, "info");
    } else {
      saveEnabledNames(ctx, pi, [...enabledNames, entry.name]);
      ctx.ui.notify(`Loading ${entry.name} for this session…`, "info");
    }
    await ctx.reload();
  };

  // ─── Autoload handler ───────────────────────────────────────────

  const handleAutoload = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const name = args.trim();
    if (!name) {
      const config = readConfig();
      const choices = config.extensions.map((e) => `${e.name} [${e.autoload ? "on" : "off"}]`);
      if (choices.length === 0) {
        ctx.ui.notify("No managed extensions.", "info");
        return;
      }
      const chosen = await pickName(ctx, "Toggle autoload for", choices);
      if (!chosen) return;
      const target = config.extensions.find((e) => `${e.name} [${e.autoload ? "on" : "off"}]` === chosen);
      if (target) await doAutoload(target.name, ctx);
      return;
    }
    await doAutoload(name, ctx);
  };

  const doAutoload = async (name: string, ctx: ExtensionContext): Promise<void> => {
    const config = readConfig();
    const ext = config.extensions.find((e) => e.name === name);
    if (!ext) {
      // Try toggling auto-discovered extension
      const entry = registry.find((e) => e.name.toLowerCase() === name.toLowerCase());
      if (!entry) {
        ctx.ui.notify(`Unknown extension: ${name}`, "error");
        return;
      }

      // Convert auto-discovered to managed
      const managed: ManagedExtension = {
        name: entry.name,
        source: entry.source,
        autoload: !entry.autoload,
        scope: entry.scope,
      };
      addManagedExtension(managed);
      ctx.ui.notify(`${entry.name}: autoload ${managed.autoload ? "on" : "off"}`, "success");
      await ctx.reload();
      return;
    }

    ext.autoload = !ext.autoload;
    writeConfig(config);
    ctx.ui.notify(`${ext.name}: autoload ${ext.autoload ? "on" : "off"}`, "success");
    await ctx.reload();
  };

  // ─── List handler ───────────────────────────────────────────────

  const handleList = (ctx: ExtensionContext): void => {
    refresh();
    const enabledNames = getEnabledNames(ctx);
    const lines = registry.map((entry) => {
      const load = entry.autoload
        ? "autoload"
        : enabledNames.includes(entry.name)
          ? "session"
          : "off";
      const source = entry.source.label;
      return `[${load}] ${entry.name} (${entry.scope}) — ${source}`;
    });

    if (lines.length === 0) {
      ctx.ui.notify("No extensions found.", "info");
      return;
    }
    ctx.ui.notify(lines.join("\n"), "info");
  };

  // ─── Register command ───────────────────────────────────────────

  pi.registerCommand(COMMAND_EXT, {
    description: "Manage extensions: install, uninstall, update, load, autoload",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      refresh();
      return getCompletions(prefix, registry, readConfig().extensions);
    },
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();
      const [subcommand, ...rest] = input.split(/\s+/);
      const restArgs = rest.join(" ");

      switch (subcommand) {
        case "list":
        case "ls":
          handleList(ctx);
          break;
        case "install":
        case "add":
          await handleInstall(restArgs, ctx);
          break;
        case "uninstall":
        case "remove":
        case "rm":
          await handleUninstall(restArgs, ctx);
          break;
        case "update":
        case "pull":
          await handleUpdate(restArgs, ctx);
          break;
        case "load":
          await handleLoad(restArgs, ctx);
          break;
        case "autoload":
          await handleAutoload(restArgs, ctx);
          break;
        case "":
          // No args — show interactive list
          if (ctx.hasUI) {
            handleList(ctx);
          } else {
            ctx.ui.notify(
              "Usage: /ext [list|install|uninstall|update|load|autoload]",
              "info",
            );
          }
          break;
        default:
          // Try as an extension name for quick load toggle
          const entry = registry.find((e) => e.name.toLowerCase() === subcommand.toLowerCase());
          if (entry) {
            await doLoad(entry.name, ctx);
          } else {
            ctx.ui.notify(
              `Unknown subcommand: ${subcommand}\nUsage: /ext [list|install|uninstall|update|load|autoload]`,
              "info",
            );
          }
      }
    },
  });
}
