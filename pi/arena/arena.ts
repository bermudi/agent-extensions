/**
 * arena — Blind model comparison inspired by LMSYS Chatbot Arena.
 *
 * Sends the same prompt to 3 models in parallel, presents the responses
 * in a randomised TUI, and lets the user vote for the best one.
 * Model identities are revealed only after voting.
 *
 * Usage:
 *   /arena                  — interactive wizard (pick prompt + 3 models)
 *   arena tool (LLM calls)  — programmatic, for LLM-initiated comparisons
 */

import { complete, type Context, type Model, type Api, type UserMessage } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import {
	Key,
	matchesKey,
	Text,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Types ─────────────────────────────────────────────────────────────────

interface ArenaResponse {
	/** Anonymous label: "Model A", "Model B", "Model C" */
	label: string;
	/** Revealed after voting: "provider/model-id" */
	identity: string;
	text: string;
	durationMs: number;
	tokens: number;
	error?: string;
}

interface ArenaDetails {
	prompt: string;
	responses: ArenaResponse[];
	vote?: string;    // "Model A" etc.
	winner?: string;  // revealed identity
	revealed: boolean;
}

/** Shape used during streaming progress updates. */
interface ArenaProgressDetails {
	prompt: string;
	responses: ArenaResponse[];
	progress: Array<{ label: string; status: string }>;
	revealed: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`;
}

export function fmtTokens(n: number): string {
	return n < 1000 ? `${n}` : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/** Fisher-Yates shuffle, returns new array. */
export function shuffled<T>(arr: T[]): T[] {
	const out = [...arr];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

export function resolveModelOrThrow(spec: string, registry: ModelRegistry): Model<Api> {
	const idx = spec.indexOf("/");
	if (idx === -1) {
		const match = registry.getAvailable().find((m) => m.id === spec);
		if (match) return match;
		throw new Error(`Unknown model id "${spec}". No match in available models.`);
	}
	const found = registry.find(spec.slice(0, idx), spec.slice(idx + 1));
	if (found) return found;
	throw new Error(`Unknown model "${spec}". Not found in registry.`);
}

const TRUNCATE_WIDTH = 120;

function textContentFrom(result: { content?: unknown }): string {
	const content = (result as { content?: Array<unknown> })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: string; text?: string } =>
			typeof c === "object" && c !== null && "type" in c && (c as { type: string }).type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

const treeChar = (i: number, n: number) => i === n - 1 ? "└─" : "├─";
const indentStr = (i: number, n: number) => i === n - 1 ? "   " : "│  ";

// ── Model Calling ─────────────────────────────────────────────────────────

async function callModel(
	model: Model<Api>,
	prompt: string,
	registry: ModelRegistry,
	signal?: AbortSignal,
): Promise<{ text: string; tokens: number; durationMs: number; error?: string }> {
	const start = Date.now();
	try {
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error((auth as { error?: string }).error ?? "no API key");

		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: prompt }],
			timestamp: Date.now(),
		};
		const context: Context = { messages: [userMessage] };

		const response = await complete(model, context, {
			apiKey: auth.apiKey,
			headers: auth.headers ?? undefined,
			signal,
		});

		if (response.stopReason === "aborted") {
			return { text: "(aborted)", tokens: 0, durationMs: Date.now() - start };
		}
		if (response.stopReason === "error") {
			return {
				text: "",
				tokens: 0,
				durationMs: Date.now() - start,
				error: response.errorMessage ?? "unknown error",
			};
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		const tokens = response.usage?.totalTokens ?? (response.usage?.input ?? 0) + (response.usage?.output ?? 0);

		return { text: text || "(no output)", tokens, durationMs: Date.now() - start };
	} catch (err) {
		return {
			text: "",
			tokens: 0,
			durationMs: Date.now() - start,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ── TUI Voting Component ──────────────────────────────────────────────────

type ThemeLike = ExtensionContext["ui"]["theme"];

export class ArenaVotingUI {
	private responses: ArenaResponse[];
	private onVote: (label: string) => void;
	private onCancel: () => void;
	private theme: ThemeLike;
	private selected = 0;

	// Caching
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(responses: ArenaResponse[], onVote: (label: string) => void, onCancel: () => void, theme: ThemeLike) {
		this.responses = responses;
		this.onVote = onVote;
		this.onCancel = onCancel;
		this.theme = theme;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			if (this.selected > 0) { this.selected--; this.invalidate(); }
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			if (this.selected < this.responses.length - 1) { this.selected++; this.invalidate(); }
		} else if (matchesKey(data, Key.enter)) {
			this.onVote(this.responses[this.selected]!.label);
		} else if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.onCancel();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const t = this.theme;
		const lines: string[] = [];

		lines.push(t.fg("accent", t.bold("🏟  Arena — Vote for the best response")));
		lines.push(t.fg("muted", "↑↓ navigate · enter vote · esc skip"));
		lines.push("");

		for (let i = 0; i < this.responses.length; i++) {
			const r = this.responses[i]!;
			const isSelected = i === this.selected;
			const icon = isSelected ? t.fg("accent", "▸") : " ";
			const label = t.fg("accent", t.bold(r.label));
			const stats = t.fg("dim", `${fmtDuration(r.durationMs)} · ${fmtTokens(r.tokens)} tokens`);

			lines.push(`${icon} ${label}  ${stats}`);
			lines.push(t.fg("borderMuted", "─".repeat(Math.max(1, width - 2))));

			if (r.error) {
				lines.push(t.fg("error", `  Error: ${r.error}`));
			} else {
				const textLines = r.text.split("\n");
				const maxLines = 12;
				const toShow = textLines.slice(0, maxLines);
				for (const line of toShow) {
					lines.push(truncateToWidth(`  ${line}`, width));
				}
				if (textLines.length > maxLines) {
					lines.push(t.fg("dim", `  … ${textLines.length - maxLines} more lines`));
				}
			}
			lines.push("");
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ── Core Arena Runner ─────────────────────────────────────────────────────

async function runArena(
	prompt: string,
	modelSpecs: [string, string, string],
	registry: ModelRegistry,
	ui: ExtensionContext["ui"],
	signal?: AbortSignal,
): Promise<{ responses: ArenaResponse[]; vote?: string; winner?: string }> {
	// Resolve models
	const models = modelSpecs.map((spec) => ({
		spec,
		model: resolveModelOrThrow(spec, registry),
	}));

	// Call all 3 in parallel
	const results = await Promise.all(models.map(async (m) => {
		const result = await callModel(m.model, prompt, registry, signal);
		return { spec: m.spec, ...result };
	}));

	// Shuffle & anonymise
	const labels = ["Model A", "Model B", "Model C"];
	const order = shuffled([0, 1, 2]);
	const responses: ArenaResponse[] = order.map((origIdx, anonIdx) => ({
		label: labels[anonIdx]!,
		identity: models[origIdx]!.spec,
		text: results[origIdx]!.text,
		durationMs: results[origIdx]!.durationMs,
		tokens: results[origIdx]!.tokens,
		error: results[origIdx]!.error,
	}));

	// Voting UI
	let vote: string | undefined;
	let winner: string | undefined;

	const chosen = await ui.custom<string | null>((tui, theme, _kb, done) => {
		const votingUI = new ArenaVotingUI(
			responses,
			(label) => done(label),
			() => done(null),
			theme,
		);
		return {
			render: (w: number) => votingUI.render(w),
			invalidate: () => { votingUI.invalidate(); },
			handleInput: (data: string) => { votingUI.handleInput(data); tui.requestRender(); },
		};
	});

	if (chosen) {
		vote = chosen;
		const winnerResp = responses.find((r) => r.label === chosen);
		winner = winnerResp?.identity;
	}

	return { responses, vote, winner };
}

function formatResults(
	responses: ArenaResponse[],
	vote?: string,
	winner?: string,
): string {
	const parts: string[] = [];
	if (vote) {
		parts.push(`🗳  Winner: ${vote} (${winner})\n`);
	} else {
		parts.push("⏭  Voting skipped.\n");
	}

	for (const r of responses) {
		const icon = r.error ? "✗" : "✓";
		const reveal = vote ? ` → ${r.identity}` : "";
		const stats = `${fmtDuration(r.durationMs)} · ${fmtTokens(r.tokens)} tokens`;
		parts.push(`${icon} ${r.label}${reveal}  (${stats})`);
		if (r.error) {
			parts.push(`   Error: ${r.error}`);
		} else {
			parts.push("");
			parts.push(r.text);
		}
		parts.push("");
	}

	return parts.join("\n");
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function arenaExtension(pi: ExtensionAPI): void {
	// ── /arena command (user-facing wizard) ──────────────────────────

	pi.registerCommand("arena", {
		description: "Blind model comparison — pit 3 models against each other",
		handler: async (args, ctx) => {
			// Step 1: get the prompt (args pre-fill the editor)
			const prompt = await ctx.ui.editor(
				"Arena — Enter prompt to send to all 3 models:",
				args || "",
			);
			if (prompt === undefined || prompt.trim() === "") {
				ctx.ui.notify("Cancelled — no prompt entered", "warning");
				return;
			}

			// Step 2: pick 3 models
			const available = ctx.modelRegistry.getAvailable();
			if (available.length < 3) {
				ctx.ui.notify("Need at least 3 configured models to run arena", "error");
				return;
			}

			const modelOptions = available.map((m) => ({
				value: `${m.provider}/${m.id}`,
				label: `${m.provider}/${m.id}`,
			}));

			const modelA = await ctx.ui.select("Select Model A:", modelOptions.map(m => m.value));
			if (!modelA) return;

			const remainingB = modelOptions.filter((m) => m.value !== modelA);
			const modelB = await ctx.ui.select("Select Model B:", remainingB.map(m => m.value));
			if (!modelB) return;

			const remainingC = remainingB.filter((m) => m.value !== modelB);
			const modelC = await ctx.ui.select("Select Model C:", remainingC.map(m => m.value));
			if (!modelC) return;

			// Step 3: run the comparison
			ctx.ui.notify("Running 3 models in parallel…", "info");

			let result: Awaited<ReturnType<typeof runArena>>;
			try {
				result = await runArena(
					prompt,
					[modelA, modelB, modelC],
					ctx.modelRegistry,
					ctx.ui,
				);
			} catch (err) {
				ctx.ui.notify(
					err instanceof Error ? err.message : "Arena failed",
					"error",
				);
				return;
			}

			// Step 4: show winner notification
			if (result.vote) {
				ctx.ui.notify(`🏟 ${result.vote} wins! (${result.winner})`, "info");
			} else {
				ctx.ui.notify("🏟 Voting skipped", "info");
			}

			// Step 5: inject results as a session message
			pi.sendMessage({
				customType: "arena-results",
				content: formatResults(result.responses, result.vote, result.winner),
				display: true,
				details: {
					prompt,
					responses: result.responses,
					vote: result.vote,
					winner: result.winner,
					revealed: !!result.vote,
				} satisfies ArenaDetails,
			});
		},
	});

	// ── arena tool (LLM-callable) ────────────────────────────────────

	pi.registerTool({
		name: "arena",
		label: "Arena",
		description:
			"Blind model comparison: send the same prompt to 3 models, " +
			"then the user votes for the best response. Models are anonymised " +
			"until after voting. Use this to compare model quality on real tasks.",
		parameters: Type.Object({
			prompt: Type.String({ description: "The prompt to send to all 3 models." }),
			modelA: Type.String({ description: "First model, e.g. 'anthropic/claude-sonnet-4' or bare id like 'gpt-4.1'" }),
			modelB: Type.String({ description: "Second model spec." }),
			modelC: Type.String({ description: "Third model spec." }),
		}),

		async execute(_id, params, signal, onUpdate, ctx) {
			const { prompt, modelA, modelB, modelC } = params;

			// ── Resolve models early for validation ────────────────────
			let modelSpecs: [string, string, string];
			try {
				modelSpecs = [modelA, modelB, modelC];
				for (const spec of modelSpecs) {
					resolveModelOrThrow(spec, ctx.modelRegistry);
				}
			} catch (err) {
				return {
					content: [{
						type: "text",
						text: err instanceof Error ? err.message : String(err),
					}],
					details: { prompt, responses: [], revealed: false } as ArenaDetails,
				};
			}

			// ── Stream progress updates ──────────────────────────────
			const progress: Array<{ label: string; status: string }> = [
				{ label: "Model A", status: "pending" },
				{ label: "Model B", status: "pending" },
				{ label: "Model C", status: "pending" },
			];
			const fireProgress = () => onUpdate?.({
				content: [{ type: "text", text: `Running 3 models…` }],
				details: { prompt, responses: [], progress, revealed: false } satisfies ArenaProgressDetails,
			});
			fireProgress();

			// We need to handle progress per-model, so call manually
			// rather than via runArena which does Promise.all
			const models = modelSpecs.map((spec) => ({
				spec,
				model: resolveModelOrThrow(spec, ctx.modelRegistry),
			}));

			const results = await Promise.all(models.map(async (m, i) => {
				progress[i]!.status = "running";
				fireProgress();
				const result = await callModel(m.model, prompt, ctx.modelRegistry, signal);
				progress[i]!.status = result.error ? "failed" : "done";
				fireProgress();
				return { spec: m.spec, ...result };
			}));

			// ── Shuffle & anonymise ──────────────────────────────────
			const labels = ["Model A", "Model B", "Model C"];
			const order = shuffled([0, 1, 2]);
			const responses: ArenaResponse[] = order.map((origIdx, anonIdx) => ({
				label: labels[anonIdx]!,
				identity: models[origIdx]!.spec,
				text: results[origIdx]!.text,
				durationMs: results[origIdx]!.durationMs,
				tokens: results[origIdx]!.tokens,
				error: results[origIdx]!.error,
			}));

			// ── Voting UI (if interactive) ───────────────────────────
			let vote: string | undefined;
			let winner: string | undefined;

			if (ctx.hasUI) {
				const chosen = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const ui = new ArenaVotingUI(
						responses,
						(label) => done(label),
						() => done(null),
						theme,
					);
					return {
						render: (w: number) => ui.render(w),
						invalidate: () => { ui.invalidate(); },
						handleInput: (data: string) => { ui.handleInput(data); tui.requestRender(); },
					};
				});

				if (chosen) {
					vote = chosen;
					const winnerResp = responses.find((r) => r.label === chosen);
					winner = winnerResp?.identity;
				}
			}

			return {
				content: [{ type: "text", text: formatResults(responses, vote, winner) }],
				details: {
					prompt,
					responses,
					vote,
					winner,
					revealed: !!vote,
				} satisfies ArenaDetails,
			};
		},

		renderCall(args, theme, _ctx) {
			const models = [args.modelA, args.modelB, args.modelC];
			const lines = [
				theme.fg("toolTitle", theme.bold("arena")),
			];
			for (let i = 0; i < 3; i++) {
				lines.push(`${treeChar(i, 3)} ${theme.fg("accent", models[i] ?? "?")}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, options, theme, _ctx) {
			const details = result.details as ArenaDetails | undefined;

			if (!details?.responses?.length) {
				return new Text(textContentFrom(result), 0, 0);
			}

			const lines: string[] = [];

			// Header
			if (details.vote) {
				lines.push(theme.fg("success", `🗳  ${details.vote} wins!`) + " " + theme.fg("muted", `(${details.winner})`));
			} else {
				lines.push(theme.fg("muted", "⏭  No vote cast"));
			}
			lines.push("");

			for (let i = 0; i < details.responses.length; i++) {
				const r = details.responses[i]!;
				const icon = r.error ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const reveal = details.revealed ? ` ${theme.fg("dim", "→")} ${theme.fg("accent", r.identity)}` : "";
				const stats = theme.fg("dim", `${fmtDuration(r.durationMs)} · ${fmtTokens(r.tokens)} tok`);

				lines.push(`${treeChar(i, details.responses.length)} ${icon} ${theme.bold(r.label)}${reveal}  ${stats}`);

				const ind = indentStr(i, details.responses.length);
				if (r.error) {
					lines.push(`${ind}${theme.fg("error", r.error)}`);
				} else {
					const outputLines = r.text.split("\n");
					const maxLines = options.expanded ? outputLines.length : 4;
					for (const line of outputLines.slice(0, maxLines)) {
						lines.push(`${ind}${theme.fg("toolOutput", truncateToWidth(line, TRUNCATE_WIDTH))}`);
					}
					const remaining = outputLines.length - maxLines;
					if (remaining > 0) {
						lines.push(`${ind}${theme.fg("muted", `… ${remaining} more lines`)}`);
					}
				}
			}

			if (!options.expanded) {
				lines.push(theme.fg("muted", "(Ctrl+O to expand)"));
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
