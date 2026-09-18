#!/usr/bin/env bun
/**
 * pilab — sandboxed pi launcher.
 *
 * Runs the real `pi` CLI against a disposable config dir so test providers,
 * extensions, system prompts and "hooks" (pi has no separate hooks config —
 * hooks live inside extensions, so testing them == testing extensions) never
 * touch ~/.pi/agent. Isolation is pi's own PI_CODING_AGENT_DIR env var; the
 * sandbox agent dir only contains what you explicitly borrow.
 *
 * Sandboxes live in ~/.pi/sandboxes/<name>/ :
 *   sandbox.json   manifest (name, created, lastUsed, borrow[])
 *   agent/         <- handed to pi as PI_CODING_AGENT_DIR
 *     settings.json   generated: allowlist copy of real settings (default
 *                     provider/model, theme, tuiMode — never packages,
 *                     extensions, skills or prompts)
 *     auth.json       -> real auth.json        (borrow "auth", default ON)
 *     keybindings.json -> real                 (borrow "keybindings", default ON)
 *     themes/*        -> real entries          (borrow "themes", default ON)
 *     models.json     -> real models.json      (borrow "models", default OFF —
 *                                              usually what's under test)
 *     AGENTS.md       -> real global AGENTS.md (borrow "agents", default OFF);
 *                        when off, a sandbox-local file lives here
 *     extensions/     empty; drop test extensions here
 *
 * auth.json is symlinked (not copied) on purpose: pi rewrites it in place on
 * OAuth refresh, so a live link keeps one source of truth instead of
 * forking refresh tokens.
 *
 * Usage:
 *   pilab                          interactive picker (TTY); without a TTY
 *                                  prints usage + sandbox list
 *   pilab <name> [opts] [-- ...]   run pi in sandbox <name> (creates it with
 *                                  default borrows if missing)
 *       --model <provider/id>      pass --model to pi
 *       --ext <path>               pass -e <abs path> to pi (repeatable)
 *       --borrow <a,b,c>           borrows at creation (implies not-default)
 *       --no-borrow                create with nothing borrowed
 *       -- ...                     everything after -- is passed to pi verbatim
 *   pilab new <name> [--borrow a,b | --no-borrow]
 *   pilab ls                       list sandboxes
 *   pilab path <name>              print the sandbox agent dir (export it:
 *                                  export PI_CODING_AGENT_DIR=$(pilab path x))
 *   pilab edit <name> settings|models|agents|manifest
 *                                  open a sandbox file in $EDITOR (edits the
 *                                  real file through the symlink if borrowed)
 *   pilab borrow <name> <what...>   borrow from the real config
 *   pilab unborrow <name> <what...> stop borrowing (models/agents get a fresh
 *                                  local file; your real files are never
 *                                  touched — only pilab's own symlinks)
 *   pilab rm <name>                trash the sandbox (trash CLI if present,
 *                                  else moved to <root>/.trash/)
 *
 * Env:
 *   PILAB_ROOT           sandbox root override (default ~/.pi/sandboxes)
 *   PILAB_REAL_AGENT_DIR real agent dir override (default ~/.pi/agent)
 *   EDITOR / VISUAL      used by `pilab edit`
 */
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

export class PilabError extends Error {}
export class PilabInterrupt extends Error {}
function fail(msg: string): never {
  throw new PilabError(msg);
}
function note(msg: string): void {
  console.log(`[pilab] ${msg}`);
}
function warn(msg: string): void {
  console.error(`[pilab] warning: ${msg}`);
}

// ---------------------------------------------------------------------------
// paths

function root(): string {
  return process.env.PILAB_ROOT
    ? resolve(expandTilde(process.env.PILAB_ROOT))
    : join(homedir(), ".pi", "sandboxes");
}
function realAgentDir(): string {
  return process.env.PILAB_REAL_AGENT_DIR
    ? resolve(expandTilde(process.env.PILAB_REAL_AGENT_DIR))
    : join(homedir(), ".pi", "agent");
}
function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}
/** Bun.which reads the env snapshot from process start; this scans the live
 * process.env.PATH so overrides (and tests) work. Broken symlinks are skipped,
 * not fatal. */
function whichLive(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      const st = statSync(p); // follows symlinks; throws on broken ones
      if (st.isFile() && st.mode & 0o111) return p;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}
function tildePath(p: string): string {
  const h = homedir();
  return p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

interface SandboxPaths {
  name: string;
  dir: string;
  agent: string;
  manifest: string;
}
export function sandboxPaths(name: string): SandboxPaths {
  validateName(name);
  const dir = resolve(root(), name);
  const r = resolve(root());
  if (dir !== r && !dir.startsWith(r + "/"))
    fail(`path escapes sandbox root: ${name}`);
  return {
    name,
    dir,
    agent: join(dir, "agent"),
    manifest: join(dir, "sandbox.json"),
  };
}
function assertSandbox(sb: SandboxPaths): void {
  if (!existsSync(sb.manifest)) {
    fail(`no such sandbox: ${sb.name} (see: pilab ls)`);
  }
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const RESERVED = new Set([
  "help",
  "ls",
  "new",
  "path",
  "rm",
  "edit",
  "borrow",
  "unborrow",
]);
function validateName(name: string): void {
  if (!NAME_RE.test(name)) {
    fail(`invalid sandbox name "${name}": must match ${NAME_RE.source}`);
  }
  if (RESERVED.has(name)) {
    fail(`"${name}" is a pilab subcommand and cannot be a sandbox name`);
  }
}

// ---------------------------------------------------------------------------
// borrows

export const BORROW_ORDER = [
  "auth",
  "keybindings",
  "themes",
  "models",
  "agents",
] as const;
type BorrowId = (typeof BORROW_ORDER)[number];
export const DEFAULT_BORROW: readonly BorrowId[] = [
  "auth",
  "keybindings",
  "themes",
];
const BORROW_DESC: Record<BorrowId, string> = {
  auth: "provider credentials (auth.json, live symlink)",
  keybindings: "keybindings.json",
  themes: "custom themes",
  models: "models.json (your custom providers)",
  agents: "global AGENTS.md",
};

function isBorrowId(x: string): x is BorrowId {
  return (BORROW_ORDER as readonly string[]).includes(x);
}
export function parseBorrowList(spec: string): Set<BorrowId> {
  const out = new Set<BorrowId>();
  for (const raw of spec.split(",")) {
    const id = raw.trim();
    if (!id) continue;
    if (!isBorrowId(id)) {
      fail(`unknown borrow "${id}" (known: ${BORROW_ORDER.join(", ")})`);
    }
    out.add(id);
  }
  return out;
}

interface Manifest {
  pilab: 1;
  name: string;
  created: string;
  lastUsed?: string;
  borrow: BorrowId[];
}

function readManifest(sb: SandboxPaths): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sb.manifest, "utf8"));
  } catch (e) {
    return fail(
      `cannot read ${tildePath(sb.manifest)}: ${(e as Error).message}`,
    );
  }
  const m = raw as Partial<Manifest>;
  if (
    !m ||
    m.pilab !== 1 ||
    typeof m.name !== "string" ||
    !Array.isArray(m.borrow)
  ) {
    return fail(`${tildePath(sb.manifest)} is not a pilab manifest`);
  }
  return {
    pilab: 1,
    name: m.name,
    created:
      typeof m.created === "string" ? m.created : new Date().toISOString(),
    lastUsed: typeof m.lastUsed === "string" ? m.lastUsed : undefined,
    borrow: m.borrow.filter(
      (b): b is BorrowId => typeof b === "string" && isBorrowId(b),
    ),
  };
}
function writeManifest(sb: SandboxPaths, m: Manifest): void {
  writeFileSync(
    sb.manifest,
    JSON.stringify({ ...m, name: sb.name }, null, 2) + "\n",
  );
}

function isOwnSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function linkInto(linkPath: string, srcPath: string, label: string): boolean {
  if (!existsSync(srcPath)) {
    warn(
      `nothing to borrow for ${label}: ${tildePath(srcPath)} does not exist`,
    );
    return false;
  }
  const target = realpathSync(srcPath);
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(linkPath);
  } catch {
    /* not there yet */
  }
  if (existing?.isSymbolicLink()) {
    if (readlinkSync(linkPath) === target) return true; // already borrowed
    unlinkSync(linkPath);
  } else if (existing) {
    warn(
      `${label}: ${tildePath(linkPath)} already exists and is not a pilab symlink; leaving it alone`,
    );
    return false;
  }
  symlinkSync(target, linkPath);
  note(`borrowed ${label} -> ${tildePath(target)}`);
  return true;
}

function unlinkOwnSymlink(path: string, label: string): boolean {
  if (!isOwnSymlink(path)) return false;
  unlinkSync(path);
  note(`unborrowed ${label}`);
  return true;
}

function ensureModelsScaffold(sb: SandboxPaths): void {
  const p = join(sb.agent, "models.json");
  if (existsSync(p)) return;
  writeFileSync(
    p,
    JSON.stringify(
      {
        $comment: `pilab sandbox ${sb.name}: add test providers here`,
        providers: {},
      },
      null,
      2,
    ) + "\n",
  );
}
function ensureAgentsScaffold(sb: SandboxPaths): void {
  const p = join(sb.agent, "AGENTS.md");
  if (existsSync(p)) return;
  writeFileSync(
    p,
    `# ${sb.name} (pilab sandbox)\n\nGlobal instructions for this sandbox only. The real ~/.pi/agent/AGENTS.md is NOT borrowed — run \`pilab borrow ${sb.name} agents\` to symlink it in.\n`,
  );
}

/** Files pilab itself generated carry the "pilab sandbox" marker; those (and
 * only those) may be replaced when the user re-borrows the real thing. */
function isPilabScaffold(p: string): boolean {
  try {
    if (!lstatSync(p).isFile()) return false;
    return readFileSync(p, "utf8").includes("pilab sandbox");
  } catch {
    return false;
  }
}

function applyBorrow(sb: SandboxPaths, id: BorrowId): boolean {
  const real = realAgentDir();
  const a = sb.agent;
  switch (id) {
    case "auth":
      return linkInto(
        join(a, "auth.json"),
        join(real, "auth.json"),
        "auth.json",
      );
    case "keybindings":
      return linkInto(
        join(a, "keybindings.json"),
        join(real, "keybindings.json"),
        "keybindings.json",
      );
    case "models": {
      const p = join(a, "models.json");
      if (isPilabScaffold(p)) {
        unlinkSync(p);
        note(
          "replaced the pilab models.json scaffold with the borrowed models.json",
        );
      }
      return linkInto(p, join(real, "models.json"), "models.json");
    }
    case "agents": {
      const p = join(a, "AGENTS.md");
      if (isPilabScaffold(p)) {
        unlinkSync(p);
        note(
          "replaced the pilab AGENTS.md scaffold with the borrowed AGENTS.md",
        );
      }
      return linkInto(p, join(real, "AGENTS.md"), "AGENTS.md");
    }
    case "themes": {
      const srcDir = join(real, "themes");
      if (!existsSync(srcDir)) {
        warn(
          "nothing to borrow for themes: no themes dir in the real agent dir",
        );
        return false;
      }
      mkdirSync(join(a, "themes"), { recursive: true });
      let any = false;
      for (const entry of readdirSync(srcDir)) {
        any =
          linkInto(
            join(a, "themes", entry),
            join(srcDir, entry),
            `themes/${entry}`,
          ) || any;
      }
      return any;
    }
  }
}

function unapplyBorrow(sb: SandboxPaths, id: BorrowId): void {
  const a = sb.agent;
  switch (id) {
    case "auth":
      unlinkOwnSymlink(join(a, "auth.json"), "auth.json");
      break;
    case "keybindings":
      unlinkOwnSymlink(join(a, "keybindings.json"), "keybindings.json");
      break;
    case "models":
      if (unlinkOwnSymlink(join(a, "models.json"), "models.json")) {
        ensureModelsScaffold(sb);
        note("models.json is now sandbox-local (empty providers scaffold)");
      }
      break;
    case "agents":
      if (unlinkOwnSymlink(join(a, "AGENTS.md"), "AGENTS.md")) {
        ensureAgentsScaffold(sb);
        note("AGENTS.md is now sandbox-local");
      }
      break;
    case "themes": {
      const dir = join(a, "themes");
      if (!existsSync(dir)) break;
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (isOwnSymlink(p)) {
          unlinkSync(p);
        } else {
          warn(`themes/${entry} is not a pilab symlink; leaving it in place`);
        }
      }
      try {
        rmSync(dir, { recursive: true });
        note("unborrowed themes");
      } catch {
        /* dir still has user files; keep it */
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// create / list / remove

const SETTINGS_ALLOW = [
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "theme",
  "tuiMode",
] as const;

function generateSettings(): { text: string; copied: string[] } {
  let src: Record<string, unknown> = {};
  const real = join(realAgentDir(), "settings.json");
  try {
    src = JSON.parse(readFileSync(real, "utf8")) as Record<string, unknown>;
  } catch (e) {
    warn(
      `could not read real settings (${(e as Error).message}); starting from empty`,
    );
  }
  const out: Record<string, unknown> = {};
  for (const k of SETTINGS_ALLOW) {
    if (k in src) out[k] = src[k];
  }
  return {
    text: JSON.stringify(out, null, 2) + "\n",
    copied: Object.keys(out),
  };
}

export function createSandbox(
  name: string,
  borrow: Set<BorrowId>,
): SandboxPaths {
  validateName(name);
  const sb = sandboxPaths(name);
  if (existsSync(sb.dir)) fail(`sandbox already exists: ${name}`);
  if (resolve(sb.agent) === resolve(realAgentDir())) {
    fail("sandbox agent dir would be the real agent dir; refusing");
  }
  mkdirSync(sb.agent, { recursive: true, mode: 0o700 });
  const { text, copied } = generateSettings();
  writeFileSync(join(sb.agent, "settings.json"), text);
  mkdirSync(join(sb.agent, "extensions"));
  note(`created sandbox ${name} in ${tildePath(sb.dir)}`);
  note(
    `settings.json: copied ${copied.length ? copied.join(", ") : "nothing"} from real settings ` +
      "(packages/extensions/skills/prompts are never copied)",
  );
  for (const id of BORROW_ORDER) {
    if (borrow.has(id)) applyBorrow(sb, id);
  }
  if (!borrow.has("models")) ensureModelsScaffold(sb);
  if (!borrow.has("agents")) ensureAgentsScaffold(sb);
  writeManifest(sb, {
    pilab: 1,
    name,
    created: new Date().toISOString(),
    borrow: BORROW_ORDER.filter((b) => borrow.has(b)),
  });
  return sb;
}

export function listSandboxes(): { sb: SandboxPaths; manifest: Manifest }[] {
  const r = root();
  if (!existsSync(r)) return [];
  const out: { sb: SandboxPaths; manifest: Manifest }[] = [];
  for (const entry of readdirSync(r, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const sb = sandboxPaths(entry.name);
    if (!existsSync(sb.manifest)) continue;
    try {
      out.push({ sb, manifest: readManifest(sb) });
    } catch {
      warn(`skipping ${entry.name}: unreadable manifest`);
    }
  }
  out.sort(
    (a, b) =>
      (Date.parse(b.manifest.lastUsed ?? "") ||
        Date.parse(b.manifest.created) ||
        0) -
      (Date.parse(a.manifest.lastUsed ?? "") ||
        Date.parse(a.manifest.created) ||
        0),
  );
  return out;
}

export function humanSince(iso?: string): string {
  if (!iso) return "never used";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "never used";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

export function setBorrow(name: string, ids: BorrowId[], on: boolean): void {
  const sb = sandboxPaths(name);
  assertSandbox(sb);
  const m = readManifest(sb);
  for (const id of ids) {
    if (!isBorrowId(id))
      fail(`unknown borrow "${id}" (known: ${BORROW_ORDER.join(", ")})`);
    if (on) {
      if (applyBorrow(sb, id)) {
        if (!m.borrow.includes(id)) m.borrow.push(id);
      }
    } else {
      unapplyBorrow(sb, id);
      m.borrow = m.borrow.filter((b) => b !== id);
    }
  }
  m.borrow = BORROW_ORDER.filter((b) => m.borrow.includes(b));
  writeManifest(sb, m);
}

export function rmSandbox(name: string): void {
  const sb = sandboxPaths(name);
  assertSandbox(sb);
  const trash = whichLive("trash");
  if (trash) {
    const p = spawnSync(trash, [sb.dir], { stdio: "ignore" });
    if (p.status === 0) {
      note(`trashed ${tildePath(sb.dir)}`);
      return;
    }
    warn(`trash exited with ${p.status ?? "signal"}; falling back to .trash/`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dst = join(root(), ".trash", `${name}-${stamp}`);
  mkdirSync(resolve(dst, ".."), { recursive: true, mode: 0o700 });
  renameSync(sb.dir, dst);
  note(`moved ${tildePath(sb.dir)} -> ${tildePath(dst)}`);
}

// ---------------------------------------------------------------------------
// run

function childEnv(agentDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.PI_CODING_AGENT_DIR = agentDir;
  for (const k of ["PI_PACKAGE_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
    if (k in env) {
      delete env[k];
      warn(`dropped ${k} from pi's environment (it would fight the sandbox)`);
    }
  }
  return env;
}

export async function runSandbox(
  name: string,
  piArgs: string[],
): Promise<number> {
  const sb = sandboxPaths(name);
  assertSandbox(sb);
  if (resolve(sb.agent) === resolve(realAgentDir())) {
    fail("sandbox agent dir is the real agent dir; refusing to run");
  }
  const pi = whichLive("pi");
  if (!pi) fail("`pi` not found on PATH");
  const m = readManifest(sb);
  m.lastUsed = new Date().toISOString();
  try {
    writeManifest(sb, m);
  } catch (e) {
    warn(`could not update lastUsed: ${(e as Error).message}`);
  }
  note(`launching pi in sandbox "${name}"`);
  note(`  agent dir: ${tildePath(sb.agent)}`);
  if (piArgs.length) note(`  pi args:   ${piArgs.join(" ")}`);
  const proc = Bun.spawn([pi, ...piArgs], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    cwd: process.cwd(),
    env: childEnv(sb.agent),
  });
  const onSigint = (): void => {}; // pi owns the terminal; let it handle ^C
  process.on("SIGINT", onSigint);
  let code: number;
  try {
    code = (await proc.exited) ?? 0;
  } finally {
    process.off("SIGINT", onSigint);
  }
  note(`pi exited with code ${code}`);
  return code;
}

// ---------------------------------------------------------------------------
// edit

function checkJson(path: string, what: string): void {
  try {
    JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    warn(`${what} does not parse as JSON: ${(e as Error).message}`);
  }
}

function editTarget(sb: SandboxPaths, what: string): string {
  switch (what) {
    case "settings":
      return join(sb.agent, "settings.json");
    case "models":
      ensureModelsScaffold(sb);
      return join(sb.agent, "models.json");
    case "agents":
      ensureAgentsScaffold(sb);
      return join(sb.agent, "AGENTS.md");
    case "manifest":
      return sb.manifest;
    default:
      return fail(
        `unknown edit target "${what}" (settings | models | agents | manifest)`,
      );
  }
}

function editInEditor(sb: SandboxPaths, what: string): void {
  const target = editTarget(sb, what);
  const editor =
    process.env.EDITOR ||
    process.env.VISUAL ||
    Bun.which("vi") ||
    Bun.which("nano");
  if (!editor) fail("no EDITOR/VISUAL set and no vi/nano on PATH");
  note(`editing ${what}: ${tildePath(realpathSync(target))}`);
  const p = spawnSync(editor, [target], { stdio: "inherit" });
  if (p.status !== 0) warn(`${editor} exited with ${p.status ?? "signal"}`);
  if (what === "settings" || what === "models" || what === "manifest")
    checkJson(target, what);
}

// ---------------------------------------------------------------------------
// interactive picker

interface PickerCtx {
  rows: { text: string; checked?: boolean }[];
  multi: boolean;
  title: string;
}

export async function pick(ctx: PickerCtx): Promise<number | null> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function")
    return null;
  let cursor = 0;
  let rendered = 0;
  const { rows, multi, title } = ctx;

  const draw = (): void => {
    const lines: string[] = ["", title];
    rows.forEach((r, i) => {
      const sel = i === cursor;
      const mark = multi ? (r.checked ? "[x]" : "[ ]") : "  ";
      const pointer = sel ? "❯" : " ";
      const text = sel ? `\x1b[1m${r.text}\x1b[0m` : r.text;
      lines.push(`${pointer} ${mark} ${text}`);
    });
    lines.push(
      multi
        ? "  space toggle · enter confirm · esc cancel"
        : "  enter select · esc cancel",
    );
    let out = "";
    if (rendered > 0) out += `\x1b[${rendered}A`;
    out += lines.map((l) => `\x1b[2K${l}`).join("\n") + "\n";
    rendered = lines.length;
    process.stdout.write(out);
  };

  process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?25l");
  draw();
  return new Promise<number | null>((resolveP) => {
    const cleanup = (value: number | null): void => {
      process.stdin.removeListener("data", onData);
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* stdin may already be gone */
      }
      process.stdout.write("\x1b[?25h");
      process.stdout.write("\x1b[2K\r");
      resolveP(value);
    };
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      if (s === "\x03" || s === "\x04") {
        cleanup(null);
        throw new PilabInterrupt();
      }
      if (s === "\x1b") {
        cleanup(null);
        return;
      }
      if (s.startsWith("\x1b[")) {
        const key = s.slice(2);
        if (key === "A" || key === "D")
          cursor = (cursor - 1 + rows.length) % rows.length;
        if (key === "B" || key === "C") cursor = (cursor + 1) % rows.length;
      } else if (s === "\r" || s === "\n") {
        cleanup(cursor);
        return;
      } else if (s === " " && multi) {
        rows[cursor]!.checked = !rows[cursor]!.checked;
      } else if (s === "j") {
        cursor = (cursor + 1) % rows.length;
      } else if (s === "k") {
        cursor = (cursor - 1 + rows.length) % rows.length;
      }
      draw();
    };
    process.stdin.on("data", onData);
  });
}

async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function newSandboxFlow(): Promise<string | null> {
  let name = "";
  for (;;) {
    name = await promptLine("sandbox name: ");
    if (!name) return null;
    try {
      validateName(name);
      if (existsSync(sandboxPaths(name).dir)) {
        console.log(`  already exists — pick another name`);
        continue;
      }
      break;
    } catch (e) {
      if (e instanceof PilabInterrupt) throw e;
      console.log(`  ${(e as Error).message}`);
    }
  }
  const rows = BORROW_ORDER.map((id) => ({
    text: `${id.padEnd(12)} ${BORROW_DESC[id]}`,
    checked: DEFAULT_BORROW.includes(id),
  }));
  const picked = await pick({
    title: `borrow into "${name}":`,
    rows,
    multi: true,
  });
  if (picked === null) throw new PilabInterrupt();
  const borrow = new Set<BorrowId>(
    BORROW_ORDER.filter((_, i) => rows[i]!.checked),
  );
  createSandbox(name, borrow);
  return name;
}

async function pickerFlow(): Promise<number> {
  const items = listSandboxes();
  const rows = items.map(({ sb, manifest }) => ({
    text: `${sb.name.padEnd(16)} [${manifest.borrow.join(",") || "nothing"}]  ${humanSince(manifest.lastUsed)}`,
  }));
  rows.push({ text: "+ new sandbox…" });
  const picked = await pick({
    title: "pilab — pick a sandbox:",
    rows,
    multi: false,
  });
  if (picked === null) return 0;
  if (picked === rows.length - 1) {
    const name = await newSandboxFlow();
    if (!name) return 0;
    return runSandbox(name, []);
  }
  return runSandbox(items[picked]!.sb.name, []);
}

// ---------------------------------------------------------------------------
// CLI parsing

interface RunSpec {
  piArgs: string[];
  borrow?: Set<BorrowId>;
}

export function parseRunArgs(rest: string[]): RunSpec {
  const piArgs: string[] = [];
  const front: string[] = [];
  const exts: string[] = [];
  let model: string | undefined;
  let borrow: Set<BorrowId> | undefined;
  const takeValue = (flag: string): string => {
    const eq = flag.indexOf("=");
    if (eq !== -1) return flag.slice(eq + 1);
    const v = rest[++i];
    if (v === undefined) fail(`${flag.split("=")[0]} needs a value`);
    return v;
  };
  let i = -1;
  for (i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (t === "--") {
      piArgs.push(...rest.slice(i + 1));
      break;
    }
    if (t === "--model" || t.startsWith("--model=")) {
      model = takeValue(t);
    } else if (t === "--ext" || t.startsWith("--ext=")) {
      const v = takeValue(t);
      const abs = resolve(expandTilde(v));
      if (!existsSync(abs)) fail(`--ext: no such file: ${v}`);
      exts.push(abs);
    } else if (t === "--borrow") {
      i++;
      const v = rest[i];
      if (v === undefined) fail("--borrow needs a comma-separated list");
      borrow = parseBorrowList(v);
    } else if (t === "--no-borrow") {
      borrow = new Set();
    } else if (t.startsWith("-")) {
      fail(
        `unknown option "${t}" (before -- only: --model, --ext, --borrow, --no-borrow; ` +
          "pi flags like -e/--system-prompt/-nc go after --)",
      );
    } else {
      fail(`unexpected argument "${t}" (pi flags go after --)`);
    }
  }
  for (const e of exts) front.push("-e", e);
  if (model !== undefined) front.push("--model", model);
  return { piArgs: [...front, ...piArgs], borrow };
}

function parseBorrowFlags(rest: string[]): Set<BorrowId> {
  let borrow: Set<BorrowId> | undefined;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (t === "--borrow") {
      const v = rest[++i];
      if (v === undefined) fail("--borrow needs a comma-separated list");
      borrow = parseBorrowList(v);
    } else if (t === "--no-borrow") {
      borrow = new Set();
    } else {
      fail(
        `unexpected argument "${t}" (new supports only --borrow / --no-borrow)`,
      );
    }
  }
  return borrow ?? new Set(DEFAULT_BORROW);
}

function printUsage(out: typeof console.log): void {
  out(`pilab — sandboxed pi launcher (sandboxes in ${tildePath(root())})

  pilab                          pick a sandbox (interactive)
  pilab <name> [--model p/m] [--ext file]... [-- <pi args>]
                                 run pi in a sandbox (created on first use)
  pilab new <name> [--borrow a,b | --no-borrow]
  pilab ls                       list sandboxes
  pilab path <name>              print the sandbox agent dir
  pilab edit <name> settings|models|agents|manifest
  pilab borrow <name> <what...>     what: ${BORROW_ORDER.join(", ")}
  pilab unborrow <name> <what...>
  pilab rm <name>                trash a sandbox

examples:
  pilab trykilogen --model kilo/claude-sonnet-4 -- --system-prompt 'You are a test dummy.'
  pilab hooksbox -- --ext ./my-hook-ext.ts -nc
  pilab edit trykilogen models    # add a test provider, then point --model at it
`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;

  if (!cmd) {
    if (!process.stdin.isTTY) {
      printUsage(console.error);
      const items = listSandboxes();
      console.log(
        items.length
          ? "\nsandboxes:"
          : "\nno sandboxes yet — try: pilab new <name>",
      );
      for (const { sb, manifest } of items) {
        console.log(
          `  ${sb.name.padEnd(16)} [${manifest.borrow.join(",")}]  ${humanSince(manifest.lastUsed)}`,
        );
      }
      return 1;
    }
    return pickerFlow();
  }

  switch (cmd) {
    case "help":
    case "-h":
    case "--help":
      printUsage(console.log);
      return 0;
    case "ls": {
      const items = listSandboxes();
      console.log(`sandboxes in ${tildePath(root())}:`);
      if (!items.length) console.log("  (none yet — try: pilab new <name>)");
      for (const { sb, manifest } of items) {
        console.log(
          `  ${sb.name.padEnd(16)} [${manifest.borrow.join(",")}]  ${humanSince(manifest.lastUsed)}`,
        );
      }
      return 0;
    }
    case "new": {
      const name = rest[0];
      if (!name) fail("usage: pilab new <name> [--borrow a,b | --no-borrow]");
      createSandbox(name, parseBorrowFlags(rest.slice(1)));
      return 0;
    }
    case "path": {
      const name = rest[0];
      if (!name) fail("usage: pilab path <name>");
      const sb = sandboxPaths(name);
      assertSandbox(sb);
      console.log(sb.agent);
      return 0;
    }
    case "rm": {
      const name = rest[0];
      if (!name) fail("usage: pilab rm <name>");
      rmSandbox(name);
      return 0;
    }
    case "edit": {
      const [name, what] = rest;
      if (!name || !what)
        fail("usage: pilab edit <name> settings|models|agents|manifest");
      const sb = sandboxPaths(name);
      assertSandbox(sb);
      editInEditor(sb, what);
      return 0;
    }
    case "borrow":
    case "unborrow": {
      const [name, ...whats] = rest;
      if (!name || !whats.length) {
        fail(`usage: pilab ${cmd} <name> <${BORROW_ORDER.join("|")}>...`);
      }
      for (const w of whats) {
        if (!isBorrowId(w))
          fail(`unknown borrow "${w}" (known: ${BORROW_ORDER.join(", ")})`);
      }
      setBorrow(name, whats as BorrowId[], cmd === "borrow");
      return 0;
    }
    default: {
      const name = cmd;
      const spec = parseRunArgs(rest);
      validateName(name);
      const sb = sandboxPaths(name);
      if (!existsSync(sb.manifest)) {
        const borrow = spec.borrow ?? new Set(DEFAULT_BORROW);
        note(
          `sandbox ${name} does not exist; creating it (borrow: ${[...borrow].join(",") || "nothing"})`,
        );
        createSandbox(name, borrow);
      } else if (spec.borrow) {
        fail(
          `sandbox ${name} already exists; change borrows with: pilab borrow/unborrow ${name} <what>`,
        );
      }
      return await runSandbox(name, spec.piArgs);
    }
  }
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (e) {
    if (e instanceof PilabInterrupt) process.exit(130);
    if (e instanceof PilabError) {
      console.error(`pilab: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
