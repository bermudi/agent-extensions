import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const MODEL = "google/gemini-3-flash-preview";
const SECRETS_PATH = path.join(os.homedir(), ".session-search", "secrets.json");

let _apiKey: string | null = null;

export function getApiKey(): string {
	if (_apiKey) return _apiKey;
	try {
		const secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf-8"));
		_apiKey = secrets.apiKey;
		return _apiKey!;
	} catch {
		throw new Error(
			`No API key found at ${SECRETS_PATH}. Run: /openrouter provision session-search`,
		);
	}
}

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

/**
 * Summarize a session via Gemini Flash through OpenRouter.
 * Uses the compaction engine to build a structured transcript
 * preserving reasoning, tool calls, and evidence — not just raw text.
 */
export async function summarizeSession(
	session: SearchResult,
	focusPrompt?: string,
): Promise<string> {
	const messages = parseSessionMessages(session.sessionPath);
	const turns = groupIntoTurns(messages);

	if (turns.length === 0)
		return "Empty session — no user or assistant messages found.";

	const maxPromptChars = computeCharBudget(1_000_000, SUMMARY_MAX_TOKENS, INITIAL_PROMPT);
	const transcript = buildTranscript(turns, maxPromptChars);
	const prompt = buildPrompt({
		transcript,
		customInstructions: focusPrompt,
	});

	const project = session.project;
	const date = formatDate(session.timestamp);

	const userPrompt = `Project: ${project} | Date: ${date}\n\n${prompt}`;

	const response = await fetch(OPENROUTER_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${getApiKey()}`,
		},
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{ role: "system", content: INITIAL_PROMPT },
				{ role: "user", content: userPrompt },
			],
			max_tokens: SUMMARY_MAX_TOKENS,
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`OpenRouter ${response.status}: ${err.slice(0, 200)}`);
	}

	const json = (await response.json()) as any;
	return (
		json.choices?.[0]?.message?.content?.trim() ?? "No summary generated."
	);
}
