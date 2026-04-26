/**
 * Extension Manager — toggle pi extensions on and off.
 *
 * Handles two populations of extensions:
 *   1. Symlinks in ~/.pi/agent/extensions/ (on) and optional-extensions/ (off)
 *   2. Packages in settings.json → packages[] (toggled via extensions:[] filter)
 *
 * After toggling, triggers /reload so changes take effect immediately.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const EXTENSIONS_DIR = "extensions";
const OPTIONAL_DIR = "optional-extensions";
const SETTINGS_FILE = "settings.json";

const EXT_SUFFIXES = [".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"];

function extDir() {
	return join(getAgentDir(), EXTENSIONS_DIR);
}
function optDir() {
	return join(getAgentDir(), OPTIONAL_DIR);
}
function settingsPath() {
	return join(getAgentDir(), SETTINGS_FILE);
}

function ensureDirs() {
	mkdirSync(extDir(), { recursive: true });
	mkdirSync(optDir(), { recursive: true });
}

// ─── Types ──────────────────────────────────────────────────────────

interface ExtEntry {
	name: string;
	enabled: boolean;
	/** "symlink" or "package" */
	kind: "symlink" | "package";
}

type PkgEntry = string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] };
type Settings = { packages?: PkgEntry[]; [k: string]: unknown };

// ─── Settings helpers ───────────────────────────────────────────────

function readSettings(): Settings {
	const p = settingsPath();
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return {};
	}
}

function writeSettings(settings: Settings): void {
	writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/** Derive a short display name from a package source */
function pkgName(source: string): string {
	// npm:@scope/pkg → @scope/pkg
	if (source.startsWith("npm:")) return source.slice(4).replace(/@[^@]*$/, "");
	// git:github.com/user/repo → repo
	if (source.startsWith("git:") || source.startsWith("https://") || source.startsWith("ssh://")) {
		return source.split("/").pop()?.replace(/\.git$/, "") ?? source;
	}
	// local path → directory or file name
	const resolved = resolve(getAgentDir(), source);
	const base = basename(resolved);
	return EXT_SUFFIXES.some((s) => base.endsWith(s)) ? base.replace(/\.[^.]+$/, "") : base;
}

/** Check if a package entry is effectively disabled (extensions: []) */
function isPkgDisabled(entry: PkgEntry): boolean {
	if (typeof entry === "string") return false;
	return Array.isArray(entry.extensions) && entry.extensions.length === 0;
}

/** Get the source string from a package entry */
function pkgSource(entry: PkgEntry): string {
	return typeof entry === "string" ? entry : entry.source;
}

// ─── Discovery ──────────────────────────────────────────────────────

function listAll(): ExtEntry[] {
	ensureDirs();
	const seen = new Map<string, ExtEntry>();

	// Symlink-based extensions
	for (const dir of [extDir(), optDir()]) {
		const enabled = dir === extDir();
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isSymbolicLink() && !entry.isFile()) continue;

			const name = EXT_SUFFIXES.some((s) => entry.name.endsWith(s))
				? entry.name.replace(/\.[^.]+$/, "")
				: entry.name;

			if (seen.has(name) && !enabled) continue;
			seen.set(name, { name, enabled, kind: "symlink" });
		}
	}

	// Package-based extensions
	const settings = readSettings();
	const packages = settings.packages ?? [];
	for (const pkg of packages) {
		const name = pkgName(pkgSource(pkg));
		if (seen.has(name)) continue; // don't overwrite symlink entries
		seen.set(name, {
			name,
			enabled: !isPkgDisabled(pkg),
			kind: "package",
		});
	}

	return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Toggle ─────────────────────────────────────────────────────────

function toggleSymlink(name: string): "enabled" | "disabled" | undefined {
	ensureDirs();

	for (const dir of [extDir(), optDir()]) {
		// exact match (directory-style)
		const exact = join(dir, name);
		if (existsSync(exact)) {
			const stat = lstatSync(exact);
			const target = stat.isSymbolicLink()
				? resolve(dirname(exact), readlinkSync(exact))
				: exact;
			const wasEnabled = dir === extDir();
			const destDir = wasEnabled ? optDir() : extDir();
			rmSync(exact, { force: true });
			symlinkSync(target, join(destDir, basename(exact)));
			return wasEnabled ? "disabled" : "enabled";
		}

		// file with extension suffix
		for (const suffix of EXT_SUFFIXES) {
			const p = join(dir, name + suffix);
			if (existsSync(p)) {
				const stat = lstatSync(p);
				const target = stat.isSymbolicLink()
					? resolve(dirname(p), readlinkSync(p))
					: p;
				const wasEnabled = dir === extDir();
				const destDir = wasEnabled ? optDir() : extDir();
				rmSync(p, { force: true });
				symlinkSync(target, join(destDir, basename(p)));
				return wasEnabled ? "disabled" : "enabled";
			}
		}
	}

	return undefined;
}

function togglePackage(name: string): "enabled" | "disabled" | undefined {
	const settings = readSettings();
	const packages = settings.packages ?? [];

	for (let i = 0; i < packages.length; i++) {
		const pkg = packages[i];
		const source = pkgSource(pkg);
		const pkgDisplayName = pkgName(source);

		if (pkgDisplayName !== name) continue;

		const disabled = isPkgDisabled(pkg);
		if (disabled) {
			// Re-enable: convert back to plain string (or object without extensions:[])
			if (typeof pkg === "string") {
				// already enabled? shouldn't happen but no-op
			} else {
				// Remove the extensions: [] filter — keep other filters if any
				const { extensions, ...rest } = pkg;
				packages[i] = rest.source === rest.source && Object.keys(rest).length === 1
					? rest.source  // just the source string, simplest form
					: rest;
			}
		} else {
			// Disable: wrap in object with extensions: []
			if (typeof pkg === "string") {
				packages[i] = { source: pkg, extensions: [] };
			} else {
				packages[i] = { ...pkg, extensions: [] };
			}
		}

		settings.packages = packages;
		writeSettings(settings);
		return disabled ? "enabled" : "disabled";
	}

	return undefined;
}

function toggle(name: string): "enabled" | "disabled" | "not_found" {
	// Try symlink first, then package
	return toggleSymlink(name) ?? togglePackage(name) ?? "not_found";
}

// ─── Entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ext", {
		description: "Toggle extensions on/off. /ext [name] to toggle, /ext list to see all",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();

			if (input === "list" || input === "ls" || input === "") {
				const entries = listAll();
				if (entries.length === 0) {
					ctx.ui.notify("No extensions found.", "info");
					return;
				}
				const lines = entries.map((e) => {
					const mark = e.enabled ? "✓" : "✗";
					const tag = e.kind === "package" ? " (pkg)" : "";
					return `  ${mark} ${e.name}${tag}`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const result = toggle(input);
			if (result === "not_found") {
				ctx.ui.notify(`Extension not found: ${input}`, "error");
				return;
			}
			const label = result === "enabled" ? "ON ✓" : "OFF ✗";
			ctx.ui.notify(`${input}: ${label}`, "success");
			await ctx.reload();
		},
	});
}
