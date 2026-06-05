/**
 * Session Summarizer — /summarize command for complex branched sessions.
 *
 * Handles sessions too large for a single LLM call by:
 * 1. Extracting a condensed transcript (user intent + assistant decisions, skipping raw tool output)
 * 2. Chunking into phases (delimited by compaction/handoff boundaries)
 * 3. Summarizing each phase, then synthesizing a final summary
 * 4. Showing the result in a TUI overlay
 *
 * Usage: /summarize [session-path-or-uuid]
 *   - No args: summarize current session
 *   - UUID or path: summarize an arbitrary session
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type SessionEntry = {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
		usage?: { totalTokens?: number; cost?: { total?: number } };
	};
	summary?: string;
	tokensBefore?: number;
	firstKeptEntryId?: string;
	fromId?: string;
	thinkingLevel?: string;
	provider?: string;
	modelId?: string;
};

type Phase = {
	label: string;
	text: string;
	startIdx: number;
	endIdx: number;
};

// ── Constants ──────────────────────────────────────────────────────────────

/** Max chars per chunk to stay within ~200k token budgets */
const MAX_CHUNK_CHARS = 80_000;
/** Truncate individual tool results longer than this */
const MAX_TOOL_RESULT_CHARS = 500;
/** Truncate individual assistant text blocks longer than this */
const MAX_ASSISTANT_TEXT_CHARS = 2_000;

// ── Content Extraction ─────────────────────────────────────────────────────

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts;
};

const extractToolCallSummary = (content: unknown): string[] => {
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "toolCall" && typeof block.name === "string") {
			const args = block.arguments ?? {};
			// Summarize the tool call concisely
			switch (block.name) {
				case "bash":
					lines.push(`$ ${truncate(String(args.command ?? ""), 120)}`);
					break;
				case "read":
					lines.push(`read(${args.path ?? "?"})`);
					break;
				case "write":
					lines.push(`write(${args.path ?? "?"})`);
					break;
				case "edit":
					lines.push(`edit(${args.path ?? "?"})`);
					break;
				case "delegate": {
					const tasks = args.tasks as Array<Record<string, string>> | undefined;
					const n = Array.isArray(tasks) ? tasks.length : "?";
					lines.push(`delegate(${n} tasks)`);
					break;
				}
				default:
					lines.push(`${block.name}(${truncate(JSON.stringify(args), 80)})`);
			}
		}
	}
	return lines;
};

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 3) + "...";
}

// ── Session Parsing ────────────────────────────────────────────────────────

function parseSession(filePath: string): SessionEntry[] {
	const raw = readFileSync(filePath, "utf8").trim();
	const lines = raw.split("\n");
	const entries: SessionEntry[] = [];
	for (const line of lines) {
		try {
			entries.push(JSON.parse(line));
		} catch {
			// skip malformed lines
		}
	}
	return entries;
}

/**
 * Resolve a user-provided arg to a session file path.
 * Supports: full path, partial UUID (8+ hex), or bare UUID.
 */
async function resolveSessionPath(
	arg: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	if (!arg) {
		return ctx.sessionManager.getSessionFile() ?? undefined;
	}

	// Absolute or relative path
	if (arg.includes("/") || arg.endsWith(".jsonl")) {
		const p = resolve(arg);
		try {
			readFileSync(p, "utf8");
			return p;
		} catch {
			// not a valid file
		}
	}

	// Try as partial UUID — search sessions
	const sessionDir = `${homedir()}/.pi/agent/sessions`;
	try {
		const { readdirSync } = await import("node:fs");
		const dirs = readdirSync(sessionDir, { withFileTypes: true });
		for (const dir of dirs) {
			if (!dir.isDirectory()) continue;
			const dirPath = `${sessionDir}/${dir.name}`;
			try {
				const files = readdirSync(dirPath);
				for (const f of files) {
					if (f.endsWith(".jsonl") && f.includes(arg)) {
						return `${dirPath}/${f}`;
					}
				}
			} catch {
				// skip unreadable dirs
			}
		}
	} catch {
		// no session dir
	}

	return undefined;
}

// ── Transcript Builder ─────────────────────────────────────────────────────

/**
 * Build a condensed text transcript from session entries.
 * Follows a specific branch (parentId chain) from leaf to root, then reverses.
 */
function buildCondensedTranscript(entries: SessionEntry[]): string {
	// Build id→entry map
	const byId = new Map<string, SessionEntry>();
	let leaf: SessionEntry | undefined;

	for (const e of entries) {
		if (e.id) byId.set(e.id, e);
		leaf = e; // last entry is the leaf
	}

	if (!leaf) return "";

	// Walk from leaf to root
	const chain: SessionEntry[] = [];
	let current = leaf;
	while (current) {
		chain.unshift(current);
		const pid = current.parentId;
		current = pid ? byId.get(pid) : undefined;
	}

	// Build condensed text
	const sections: string[] = [];

	for (const entry of chain) {
		if (entry.type === "compaction") {
			sections.push(`\n--- [COMPACTION: ${entry.tokensBefore ?? "?"} tokens summarized] ---`);
			if (entry.summary) {
				sections.push(entry.summary);
			}
			continue;
		}

		if (entry.type === "branch_summary") {
			sections.push(`\n--- [BRANCH FROM ${entry.fromId ?? "?"}] ---`);
			if (entry.summary) {
				sections.push(entry.summary);
			}
			continue;
		}

		if (entry.type === "model_change") {
			sections.push(`[Model: ${entry.provider}/${entry.modelId}]`);
			continue;
		}

		if (entry.type !== "message" || !entry.message?.role) continue;

		const role = entry.message.role;

		if (role === "user") {
			const text = extractTextParts(entry.message.content).join("\n").trim();
			if (text) {
				sections.push(`\n## User\n${text}`);
			}
		} else if (role === "assistant") {
			const textParts = extractTextParts(entry.message.content)
				.map((t) => truncate(t, MAX_ASSISTANT_TEXT_CHARS))
				.join("\n")
				.trim();
			const toolParts = extractToolCallSummary(entry.message.content);

			const parts: string[] = [];
			if (textParts) parts.push(textParts);
			if (toolParts.length > 0) parts.push(`Tools:\n${toolParts.map((t) => `  ${t}`).join("\n")}`);

			if (parts.length > 0) {
				sections.push(`## Assistant\n${parts.join("\n")}`);
			}
		} else if (role === "toolResult") {
			// Only include error results, and truncate heavily
			const text = extractTextParts(entry.message.content)
				.join("\n")
				.trim();
			if (text && (entry.message as any).isError) {
				sections.push(`[ERROR] ${truncate(text, MAX_TOOL_RESULT_CHARS)}`);
			}
		}
	}

	return sections.join("\n\n");
}

/**
 * Build a tree overview showing ALL branches in the session.
 * Walks the full tree, not just the current branch.
 */
function buildTreeOverview(entries: SessionEntry[]): string {
	const byId = new Map<string, SessionEntry>();
	const childrenOf = new Map<string | null, string[]>();

	for (const e of entries) {
		if (e.id) byId.set(e.id, e);
		const pid = e.parentId ?? null;
		if (!childrenOf.has(pid)) childrenOf.set(pid, []);
		childrenOf.get(pid)!.push(e.id!);
	}

	const lines: string[] = [];
	let userTurnIdx = 0;

	function renderNode(id: string, prefix: string, isLast: boolean, isBranch: boolean): void {
		const entry = byId.get(id);
		if (!entry) return;
		const connector = prefix === "" ? "" : isLast ? "└─ " : "├─ ";

		if (entry.type === "message" && entry.message?.role === "user") {
			userTurnIdx++;
			const text = extractTextParts(entry.message.content).join(" ").trim();
			const preview = truncate(text, 60).replace(/\n/g, " ");
			const branchMarker = isBranch ? " ★" : "";
			lines.push(`${prefix}${connector}Turn ${userTurnIdx}${branchMarker}: ${preview}`);
		} else if (entry.type === "compaction") {
			lines.push(`${prefix}${connector}[compaction: ${entry.tokensBefore} tokens]`);
		} else if (entry.type === "branch_summary") {
			lines.push(`${prefix}${connector}[branch summary]`);
		} else if (entry.type === "model_change") {
			lines.push(`${prefix}${connector}[→ ${entry.provider}/${entry.modelId}]`);
		}
		// Skip assistant/toolResult in tree view for brevity

		const kids = childrenOf.get(id) ?? [];
		const childPrefix = prefix === "" ? "" : prefix + (isLast ? "   " : "│  ");
		for (let i = 0; i < kids.length; i++) {
			renderNode(kids[i], childPrefix, i === kids.length - 1, kids.length > 1 && i > 0);
		}
	}

	// Start from root children
	const rootKids = childrenOf.get(null) ?? [];
	for (let i = 0; i < rootKids.length; i++) {
		renderNode(rootKids[i], "", i === rootKids.length - 1, false);
	}

	return lines.join("\n");
}

// ── Chunking ───────────────────────────────────────────────────────────────

/**
 * Split a condensed transcript into phases suitable for individual LLM calls.
 * Splits at compaction boundaries, handoff markers, or MAX_CHUNK_CHARS.
 */
function chunkIntoPhases(transcript: string): Phase[] {
	// First try to split at natural boundaries
	const boundaryRegex = /\n---\s*\[COMPACTION:.*?\]\s*---/g;
	const boundaries: { idx: number; label: string }[] = [];
	let match;
	while ((match = boundaryRegex.exec(transcript)) !== null) {
		boundaries.push({ idx: match.index, label: match[0] });
	}

	if (boundaries.length === 0 || boundaries.length === 1 && boundaries[0].idx === 0) {
		// No natural boundaries — split by size
		return splitBySize(transcript);
	}

	const phases: Phase[] = [];
	let start = 0;

	for (let i = 0; i < boundaries.length; i++) {
		const end = boundaries[i].idx;
		if (end > start) {
			const text = transcript.slice(start, end).trim();
			if (text) {
				phases.push({
					label: `Phase ${phases.length + 1}`,
					text,
					startIdx: start,
					endIdx: end,
				});
			}
		}
		start = end;
	}

	// Remaining text after last boundary
	if (start < transcript.length) {
		const text = transcript.slice(start).trim();
		if (text) {
			phases.push({
				label: `Phase ${phases.length + 1}`,
				text,
				startIdx: start,
				endIdx: transcript.length,
			});
		}
	}

	// Further split any phase that's still too large
	const result: Phase[] = [];
	for (const phase of phases) {
		if (phase.text.length > MAX_CHUNK_CHARS) {
			result.push(...splitBySize(phase.text));
		} else {
			result.push(phase);
		}
	}

	return result;
}

function splitBySize(text: string): Phase[] {
	const phases: Phase[] = [];
	const lines = text.split("\n");
	let current = "";
	let startIdx = 0;

	for (const line of lines) {
		if (current.length + line.length > MAX_CHUNK_CHARS && current.length > 0) {
			phases.push({
				label: `Chunk ${phases.length + 1}`,
				text: current.trim(),
				startIdx,
				endIdx: startIdx + current.length,
			});
			startIdx += current.length;
			current = "";
		}
		current += line + "\n";
	}

	if (current.trim()) {
		phases.push({
			label: `Chunk ${phases.length + 1}`,
			text: current.trim(),
			startIdx,
			endIdx: text.length,
		});
	}

	return phases;
}

// ── LLM Summarization ──────────────────────────────────────────────────────

const PHASE_PROMPT = `You are summarizing a coding agent session. Given a condensed transcript of one phase, produce a structured summary with:

1. **Goal**: What was the user trying to accomplish?
2. **Actions**: Key actions taken (files read, edited, commands run) — keep it brief
3. **Decisions**: Important decisions made and why
4. **Outcome**: What was the result? (tests passing, files changed, etc.)
5. **Open questions**: Anything unresolved

Be concise. Use bullet points. Skip obvious steps. Focus on what matters for someone resuming or understanding this work.

<transcript>
{transcript}
</transcript>`;

// ── Stats Extraction ───────────────────────────────────────────────────────

function extractStats(entries: SessionEntry[]): string {
	const stats: string[] = [];
	let totalTokens = 0;
	let totalCost = 0;
	let userMsgs = 0;
	let assistantMsgs = 0;
	let toolCalls = 0;

	for (const e of entries) {
		if (e.type !== "message" || !e.message) continue;
		const role = e.message.role;
		if (role === "user") userMsgs++;
		if (role === "assistant") {
			assistantMsgs++;
			const content = e.message.content;
			if (Array.isArray(content)) {
				toolCalls += content.filter((c: any) => c?.type === "toolCall").length;
			}
			if (e.message.usage) {
				totalTokens += e.message.usage.totalTokens ?? 0;
				totalCost += e.message.usage.cost?.total ?? 0;
			}
		}
	}

	stats.push(`Duration: ${entries.length} entries`);
	stats.push(`Messages: ${userMsgs} user, ${assistantMsgs} assistant`);
	stats.push(`Tool calls: ${toolCalls}`);
	if (totalTokens > 0) stats.push(`Total tokens: ${(totalTokens / 1000).toFixed(0)}k`);
	if (totalCost > 0) stats.push(`Total cost: $${totalCost.toFixed(2)}`);

	return stats.join("\n");
}

// ── LLM Summarization ──────────────────────────────────────────────────────

const SYNTHESIS_PROMPT = `You are synthesizing a full coding agent session summary from individual phase summaries and a branch tree overview.

Produce a comprehensive session summary with:

1. **Session Overview**: 2-3 sentence summary of the entire session
2. **Branch Structure**: Explain the branching — why did branches happen, what was explored vs kept
3. **Key Decisions**: Important decisions made across all phases
4. **Progress**: What was accomplished (quantify: files changed, tests passing, etc.)
5. **Open Items**: Unresolved issues, TODOs, things deferred
6. **Handoffs**: If there were context compactions/handoffs, note what was transferred
7. **Total Cost**: If usage data is available, summarize token/cost totals

Use clear headings and bullet points. Be specific — file names, test counts, line reductions.

<branch-tree>
{tree}
</branch-tree>

<phase-summaries>
{summaries}
</phase-summaries>`;

interface LLMConfig {
	model: any;
	apiKey: string;
	headers?: Record<string, string>;
}

async function summarizePhase(
	transcript: string,
	config: LLMConfig,
	signal?: AbortSignal,
): Promise<string> {
	const prompt = PHASE_PROMPT.replace("{transcript}", transcript);
	const response = await complete(
		config.model,
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
			],
		},
		{
			apiKey: config.apiKey,
			headers: config.headers,
			signal,
		},
	);
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

async function synthesizeSummary(
	treeOverview: string,
	phaseSummaries: string[],
	config: LLMConfig,
	signal?: AbortSignal,
): Promise<string> {
	const prompt = SYNTHESIS_PROMPT
		.replace("{tree}", treeOverview)
		.replace(
			"{summaries}",
			phaseSummaries.map((s, i) => `### Phase ${i + 1}\n${s}`).join("\n\n"),
		);
	const response = await complete(
		config.model,
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
			],
		},
		{
			apiKey: config.apiKey,
			headers: config.headers,
			signal,
		},
	);
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

// ── TUI ────────────────────────────────────────────────────────────────────

async function showSummaryUi(summary: string, ctx: ExtensionCommandContext) {
	if (!ctx.hasUI) {
		// Print mode — just output to stdout
		process.stdout.write(summary + "\n");
		return;
	}

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const mdTheme = getMarkdownTheme();

		container.addChild(border);
		container.addChild(
			new Text(theme.fg("accent", theme.bold("📋 Session Summary")), 1, 0),
		);
		container.addChild(new Markdown(summary, 1, 1, mdTheme));
		container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
					done(undefined);
				}
			},
		};
	});
}

// ── Main Command ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("summarize", {
		description: "Summarize a (possibly branched) session — current or by path/UUID",
		getArgumentCompletions: (prefix: string) => {
			// Auto-complete session UUIDs
			const suggestions: Array<{ value: string; label: string }> = [];
			try {
				const { readdirSync } = require("node:fs");
				const sessionDir = `${homedir()}/.pi/agent/sessions`;
				const dirs = readdirSync(sessionDir, { withFileTypes: true });
				for (const dir of dirs) {
					if (!dir.isDirectory()) continue;
					try {
						const files = readdirSync(`${sessionDir}/${dir.name}`);
						for (const f of files) {
							if (f.endsWith(".jsonl")) {
								const uuid = f.split("_").pop()?.replace(".jsonl", "") ?? "";
								const short = uuid.slice(0, 8);
								if (short.startsWith(prefix)) {
									suggestions.push({
										value: short,
										label: `${short} (${dir.name.replace(/--/g, "/").replace(/^-|-$/g, "")})`,
									});
								}
							}
						}
					} catch {
						// skip
					}
				}
			} catch {
				// no session dir
			}
			return suggestions.length > 0 ? suggestions : null;
		},
		handler: async (args, ctx) => {
			const sessionPath = await resolveSessionPath(args?.trim(), ctx);

			if (!sessionPath) {
				ctx.ui.notify("No session found. Provide a path or UUID, or run inside a session.", "error");
				return;
			}

			ctx.ui.notify(`Loading session: ${basename(sessionPath)}`, "info");

			let entries: SessionEntry[];
			try {
				entries = parseSession(sessionPath);
			} catch (err: any) {
				ctx.ui.notify(`Failed to read session: ${err.message}`, "error");
				return;
			}

			if (entries.length <= 1) {
				ctx.ui.notify("Session is empty or has no messages.", "warning");
				return;
			}

			ctx.ui.notify(`Session: ${entries.length} entries, building transcript...`, "info");

			// Build condensed transcript
			const transcript = buildCondensedTranscript(entries);
			const treeOverview = buildTreeOverview(entries);

			if (!transcript.trim()) {
				ctx.ui.notify("No conversation content found.", "warning");
				return;
			}

			// Get model for summarization — use current session model
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model configured.", "error");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth?.ok || !auth.apiKey) {
				ctx.ui.notify(`No API key for ${model.provider}/${model.id}`, "error");
				return;
			}

			const config: LLMConfig = {
				model,
				apiKey: auth.apiKey,
				headers: auth.headers,
			};

			// Check if we can summarize in one shot
			const phases = chunkIntoPhases(transcript);

			ctx.ui.notify(
				`Transcript: ${(transcript.length / 1024).toFixed(0)}KB → ${phases.length} phase(s)`,
				"info",
			);

			try {
				let summary: string;

				if (phases.length === 1) {
					// Single phase — summarize directly
					ctx.ui.notify("Summarizing session...", "info");
					summary = await summarizePhase(phases[0].text, config, ctx.signal);
				} else {
					// Multi-phase — summarize each, then synthesize
					ctx.ui.notify(`Summarizing ${phases.length} phases...`, "info");

					const phaseSummaries: string[] = [];
					for (let i = 0; i < phases.length; i++) {
						ctx.ui.notify(
							`Summarizing phase ${i + 1}/${phases.length}...`,
							"info",
						);
						const phaseSummary = await summarizePhase(
							phases[i].text,
							config,
							ctx.signal,
						);
						phaseSummaries.push(phaseSummary);
					}

					ctx.ui.notify("Synthesizing final summary...", "info");
					summary = await synthesizeSummary(
						treeOverview,
						phaseSummaries,
						config,
						ctx.signal,
					);
				}

				// Prepend stats header
				const stats = extractStats(entries);
				const header = `> **Session Stats**\n> ${stats.split("\n").join("\n> ")}`;
				summary = `${header}\n\n---\n\n${summary}`;

				// Add tree overview as appendix
				if (treeOverview.trim()) {
					summary += `\n\n---\n\n### Branch Structure\n\`\`\`\n${treeOverview}\n\`\`\``;
				}

				await showSummaryUi(summary, ctx);
			} catch (err: any) {
				if (err.name === "AbortError") return;
				ctx.ui.notify(`Summarization failed: ${err.message}`, "error");
			}
		},
	});
}
