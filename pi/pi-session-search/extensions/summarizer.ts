import * as fs from "node:fs";
import type { SearchResult } from "./indexer";
import { formatDate } from "./types";
import { parseSessionMessages } from "./jsonl-parser";
import {
	groupIntoTurns,
	buildTranscript,
	buildPrompt,
	INITIAL_PROMPT,
	computeCharBudget,
	SUMMARY_MAX_TOKENS,
} from "../../compaction-engine";
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * @deprecated Use parseSessionMessages + groupIntoTurns from compaction-engine instead.
 * Extracts user + assistant text only — loses reasoning, tool calls, and evidence.
 */
export function extractSessionText(sessionPath: string): string {
	const data = fs.readFileSync(sessionPath, "utf-8");
	const lines = data.split("\n");
	const parts: string[] = [];

	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;

		if (msg.role === "user") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: (msg.content || [])
							.filter((c: any) => c.type === "text")
							.map((c: any) => c.text)
							.join(" ");
			if (text.trim()) parts.push(`[USER] ${text.trim()}`);
		} else if (msg.role === "assistant") {
			const text = (msg.content || [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join(" ");
			if (text.trim()) parts.push(`[ASSISTANT] ${text.trim()}`);
		}
	}

	return parts.join("\n\n");
}

// ── Model resolution ──────────────────────────────────────────────────

async function resolveSummaryModel(ctx: ExtensionContext) {
	const candidates: any[] = [];

	if (ctx.model) candidates.push(ctx.model);

	for (const model of candidates) {
		if (!model) continue;
		const auth = await (ctx.modelRegistry as any).getApiKeyAndHeaders(model);
		if (auth.ok && auth.apiKey) {
			return { model, auth };
		}
	}

	return undefined;
}

/**
 * Summarize a session using the active pi model.
 * Uses the compaction engine to build a structured transcript
 * preserving reasoning, tool calls, and evidence — not just raw text.
 */
export async function summarizeSession(
	session: Pick<SearchResult, "sessionPath" | "project" | "timestamp">,
	ctx: ExtensionContext,
	focusPrompt?: string,
): Promise<string> {
	const modelChoice = await resolveSummaryModel(ctx);
	if (!modelChoice) {
		throw new Error("No model with API key available for summarization.");
	}

	const messages = parseSessionMessages(session.sessionPath);
	const turns = groupIntoTurns(messages);

	if (turns.length === 0)
		return "Empty session — no user or assistant messages found.";

	const maxPromptChars = computeCharBudget(
		modelChoice.model.contextWindow as number | undefined,
		SUMMARY_MAX_TOKENS,
		INITIAL_PROMPT,
	);
	const transcript = buildTranscript(turns, maxPromptChars);
	const prompt = buildPrompt({
		transcript,
		customInstructions: focusPrompt,
	});

	const project = session.project;
	const date = formatDate(session.timestamp);
	const userPrompt = `Project: ${project} | Date: ${date}\n\n${prompt}`;

	const response = await complete(
		modelChoice.model,
		{
			systemPrompt: INITIAL_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: userPrompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: modelChoice.auth.apiKey,
			headers: modelChoice.auth.headers,
			maxTokens: SUMMARY_MAX_TOKENS,
			signal: (ctx as any).signal,
		},
	);

	const summary = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();

	if (!summary) {
		throw new Error("Model returned an empty summary.");
	}

	return summary;
}
