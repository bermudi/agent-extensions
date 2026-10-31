import type {
	LogfareCatalogEntry,
	ProviderChatModelConfig,
	ProviderClassifierModelConfig,
	ProviderModelConfig,
} from "./types.ts";

const CHAT_ENDPOINT = "chat/completions";
const DECISIONS_ENDPOINT = "decisions";
const PI_INPUT_MODALITIES = new Set(["text", "image"]);

/**
 * Catalog metadata is sometimes absent entirely (e.g. the logfare/auto router).
 * Those entries get conservative local defaults, mirroring the hand-maintained
 * block this package replaced on 2026-10-22.
 */
const METADATA_CONTEXT_FALLBACK = 32768;
const METADATA_MAX_TOKENS = 16384;

/** The catalog publishes no output-token limits; this is the local placeholder. */
const MAX_TOKENS_PLACEHOLDER = 16384;
/** The catalog publishes no USD prices; zero cost keeps premium totals incomplete but harmless. */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * pi thinking level → upstream reasoning parameter value, per model family.
 * Transcribed 2026-10-22 from the hand-maintained models.json block; null marks
 * a level the upstream rejects. Families are matched on the model id prefix.
 * An unknown reasoning family gets NO map: pi falls back to its default
 * openai-completions behavior (the logfare/auto precedent).
 */
const THINKING_POLICIES: Array<[RegExp, Record<string, string | null>]> = [
	[
		/^deepseek/,
		{ off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	],
	[
		/^glm/,
		{ off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	],
	[
		/^gpt-5-(chat|mini|nano|kiara)/,
		{ off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	],
	[
		/^gpt-5\.\d/,
		{ off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
	],
	[
		/^minimax/,
		{ off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	],
	[
		/^qwen/,
		{ off: "none", minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null },
	],
];

/**
 * Per-id deltas on top of the general rules — the residue of hand judgment that
 * catalog metadata cannot express. Only add entries with a reason.
 */
const MODEL_OVERRIDES: Record<string, Partial<ProviderChatModelConfig>> = {
	// Router endpoint; catalog metadata is unavailable but it routes to reasoning models.
	"logfare/auto": { reasoning: true },
	// OpenAI's newer chat surface rejects max_tokens; the hand-maintained block
	// verified this model needs the completion-tokens field.
	"gpt-5.2-chat": { compat: { maxTokensField: "max_completion_tokens" } },
};

export function isChatEntry(entry: LogfareCatalogEntry): boolean {
	return (entry.endpoints ?? []).includes(CHAT_ENDPOINT);
}

/** Decisions-endpoint entries become codemode classifier models, not chat models. */
export function isDecisionsEntry(entry: LogfareCatalogEntry): boolean {
	return (entry.endpoints ?? []).includes(DECISIONS_ENDPOINT);
}

function hasMetadata(entry: LogfareCatalogEntry): boolean {
	return entry.metadata_status === "available" && Array.isArray(entry.supported_parameters);
}

function supportsReasoningEffort(entry: LogfareCatalogEntry): boolean {
	return (entry.supported_parameters ?? []).includes("reasoning_effort");
}

function mapInputModalities(entry: LogfareCatalogEntry): ("text" | "image")[] {
	if (!hasMetadata(entry)) return ["text"];
	const modalities = (entry.architecture?.input_modalities ?? []).filter((m): m is "text" | "image" =>
		PI_INPUT_MODALITIES.has(m),
	);
	if (modalities.length === 0) return ["text"];
	// Stable order (text first) so catalog-side reorderings don't churn configs.
	return modalities.includes("text") ? (["text", ...modalities.filter((m) => m !== "text")] as ("text" | "image")[]) : modalities;
}

function thinkingLevelMapFor(entry: LogfareCatalogEntry): Record<string, string | null> | null {
	if (!supportsReasoningEffort(entry)) return null;
	for (const [pattern, map] of THINKING_POLICIES) {
		if (pattern.test(entry.id)) return map;
	}
	return null;
}

export function catalogToProviderModel(entry: LogfareCatalogEntry): ProviderChatModelConfig {
	const known = hasMetadata(entry);
	const reasoning = known ? supportsReasoningEffort(entry) : false;

	const model: ProviderChatModelConfig = {
		id: entry.id,
		name: entry.display_name ?? entry.name ?? entry.id,
		input: mapInputModalities(entry),
		cost: { ...ZERO_COST },
		reasoning,
		thinkingLevelMap: thinkingLevelMapFor(entry),
		compat: known
			? supportsReasoningEffort(entry)
				? { maxTokensField: "max_tokens", supportsReasoningEffort: true }
				: { maxTokensField: "max_tokens" }
			: null,
		contextWindow:
			known && typeof entry.context_length === "number" && entry.context_length > 0
				? entry.context_length
				: METADATA_CONTEXT_FALLBACK,
		maxTokens: known ? MAX_TOKENS_PLACEHOLDER : METADATA_MAX_TOKENS,
	};

	return { ...model, ...MODEL_OVERRIDES[entry.id] };
}

/** Decisions models carry no chat metadata: no reasoning, no thinking maps, no maxTokens placeholder. */
export function catalogToClassifierModel(entry: LogfareCatalogEntry): ProviderClassifierModelConfig {
	return {
		type: "classifier",
		id: entry.id,
		name: entry.display_name ?? entry.name ?? entry.id,
		api: "logfare-decisions",
		input: mapInputModalities(entry),
		cost: { ...ZERO_COST },
		contextWindow:
			typeof entry.context_length === "number" && entry.context_length > 0
				? entry.context_length
				: METADATA_CONTEXT_FALLBACK,
	};
}

/**
 * Map the catalog to pi provider models: chat entries to chat models, decisions
 * entries to classifier models, everything else dropped. An entry exposing both
 * endpoints would yield both models — pi keys them by (type, id). Sorted by id
 * like the hand-maintained block was.
 */
export function catalogToProviderModels(entries: LogfareCatalogEntry[]): ProviderModelConfig[] {
	return [
		...entries.filter(isChatEntry).map(catalogToProviderModel),
		...entries.filter(isDecisionsEntry).map(catalogToClassifierModel),
	].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
