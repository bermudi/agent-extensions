/**
 * cc-cwd — Injects project context into CommandCode proxy requests.
 *
 * Collects the full `config` block (working directory, git state,
 * directory structure, environment) from the pi session's project
 * and sends it alongside the request. This way the proxy doesn't
 * need to shell out to git or read the project directory — it's a
 * pure translator.
 *
 * Falls back to `populateConfigFromFS` in the proxy if the config
 * block is absent (e.g. requests not from pi).
 */
import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Matches the real command-code binary's blocklist (getRootDirectoryStructure).
const DIR_BLOCKLIST = new Set([
	"node_modules", "dist", "build",
	".git", ".svn", ".hg",
	"coverage", ".nyc_output", ".cache",
	"tmp", "temp",
	".next", ".nuxt", "out",
]);

interface ProjectConfig {
	workingDir: string;
	date: string;
	environment: string;
	structure: string[];
	isGitRepo: boolean;
	currentBranch: string;
	mainBranch: string;
	gitStatus: string;
	recentCommits: string[];
}

async function git(pi: ExtensionAPI, cwd: string, ...args: string[]): Promise<string> {
	try {
		const result: ExecResult = await pi.exec("git", args, { cwd });
		return result.stdout.trim();
	} catch {
		return "";
	}
}

function readDirStructure(dir: string): string[] {
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		return entries
			.filter(e => e.isDirectory())
			.filter(e => !e.name.startsWith("."))
			.filter(e => !DIR_BLOCKLIST.has(e.name))
			.map(e => e.name)
			.sort();
	} catch {
		return [];
	}
}

function summarizePorcelain(porcelain: string): string {
	if (!porcelain) return "Working tree clean";
	const lines = porcelain.split("\n");
	let modified = 0, added = 0, deleted = 0, untracked = 0;
	for (const line of lines) {
		if (line.startsWith(" M")) modified++;
		else if (line.startsWith("A ")) added++;
		else if (line.startsWith(" D")) deleted++;
		else if (line.startsWith("??")) untracked++;
	}
	const parts: string[] = [];
	if (modified > 0) parts.push(`M ${modified}`);
	if (added > 0) parts.push(`A ${added}`);
	if (deleted > 0) parts.push(`D ${deleted}`);
	if (untracked > 0) parts.push(`?? ${untracked}`);
	return parts.join(", ") || porcelain;
}

async function collectConfig(pi: ExtensionAPI, cwd: string): Promise<ProjectConfig> {
	const isGit = existsSync(join(cwd, ".git"));

	const config: ProjectConfig = {
		workingDir: cwd,
		date: new Date().toISOString().split("T")[0],
		environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
		structure: readDirStructure(cwd),
		isGitRepo: isGit,
		currentBranch: "",
		mainBranch: "",
		gitStatus: "",
		recentCommits: [],
	};

	if (isGit) {
		config.currentBranch = await git(pi, cwd, "branch", "--show-current");

		const remotes = await git(pi, cwd, "branch", "-r");
		if (remotes.includes("origin/main")) config.mainBranch = "main";
		else if (remotes.includes("origin/master")) config.mainBranch = "master";
		else config.mainBranch = "main";

		const porcelain = await git(pi, cwd, "status", "--porcelain");
		config.gitStatus = summarizePorcelain(porcelain);

		const log = await git(pi, cwd, "log", "--oneline", "-3");
		config.recentCommits = log ? log.split("\n") : [];
	}

	return config;
}

// Read AGENTS.md if it exists. The real binary sends this as `memory`.
function readAgentsMd(cwd: string): string {
	const path = join(cwd, "AGENTS.md");
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

// Read skills from the project's skill directories. Tries `.agents/skills/`,
// `.pi/skills/`, then `.commandcode/skills/` (matching the real binary's lookup).
// Each skill is a directory containing a `SKILL.md` with YAML frontmatter.
// Returns XML in the real binary's format: `<available_skills><skill>...</skill></available_skills>`.
function readSkills(cwd: string): string {
	const skillDirs = [
		join(cwd, ".agents", "skills"),
		join(cwd, ".pi", "skills"),
		join(cwd, ".commandcode", "skills"),
	];
	let dir: string | undefined;
	for (const d of skillDirs) {
		if (existsSync(d)) {
			dir = d;
			break;
		}
	}
	if (!dir) return "";

	let skills: string[] = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const skillPath = join(dir, entry.name, "SKILL.md");
			if (!existsSync(skillPath)) continue;

			const content = readFileSync(skillPath, "utf-8");
			const name = parseFrontmatter(content, "name") || entry.name;
			const description = parseFrontmatter(content, "description") || "";
			skills.push(`<skill>\n<name>${escapeXml(name)}</name>\n<description>${escapeXml(description)}</description>\n<location>${escapeXml(skillPath)}</location>\n</skill>`);
		}
	} catch {
		// ignore
	}

	if (skills.length === 0) return "";
	return `<available_skills>\n${skills.join("\n")}\n</available_skills>`;
}

// Parse a simple YAML frontmatter field: `key: value` or `key: |\n  value`.
function parseFrontmatter(content: string, key: string): string {
	// Look for the key after the --- frontmatter block
	const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!frontmatter) return "";

	const fm = frontmatter[1];

	// Try multi-line block scalar first: `key: |\n  value\n  value`
	const multi = fm.match(new RegExp(`^${key}:\\s*\\|\\s*\\n((?:\\s+.*\\n?)*)`, "m"));
	if (multi) {
		return multi[1]
			.split("\n")
			.map(line => line.replace(/^\s+/, ""))
			.join("\n")
			.trim();
	}

	// Try single-line: `key: value`
	const single = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
	if (single) return single[1].trim();

	return "";
}

function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", async (event, ctx) => {
		if (ctx.model?.provider !== "commandcode") return;
		if (!ctx.cwd) return;

		const config = await collectConfig(pi, ctx.cwd);
		const memory = readAgentsMd(ctx.cwd);
		const skills = readSkills(ctx.cwd);

		const payload: Record<string, any> = {
			...event.payload,
			x_command_code_working_dir: ctx.cwd,
			x_command_code_config: config,
			// pi's user has taste learning OFF (their command-code
			// userConfig.tasteLearning is false). The proxy would
			// otherwise hardcode "true". Forward the actual preference
			// so x-taste-learning matches what command-code sends.
			x_command_code_taste_learning: false,
		};
		if (memory) {
			payload.x_command_code_memory = memory;
		}
		if (skills) {
			payload.x_command_code_skills = skills;
		}

		return payload;
	});
}
