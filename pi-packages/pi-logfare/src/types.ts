/** One entry of Logfare's public GET /v1/models response (`data[]`). */
export interface LogfareCatalogEntry {
	id: string;
	name?: string | null;
	display_name?: string | null;
	context_length?: number | null;
	supported_parameters?: string[] | null;
	architecture?: {
		input_modalities?: string[] | null;
		output_modalities?: string[] | null;
	} | null;
	endpoints?: string[] | null;
	visibility?: string | null;
	tier?: number | null;
	premium_unlocked?: boolean | null;
	metadata_status?: string | null;
}

export interface LogfareCatalog {
	object?: string;
	data?: LogfareCatalogEntry[];
}

/** Shape accepted by pi's `registerProvider` models / `refreshModels` return — chat flavor. Omitted `type` is normalized to chat, mirroring pi. */
export interface ProviderChatModelConfig {
	type?: "chat";
	id: string;
	name: string;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null> | null;
	compat?: Record<string, unknown> | null;
	contextWindow: number;
	maxTokens: number;
}

/**
 * Codemode classifier flavor, for catalog entries served by Logfare's decisions
 * endpoint (`POST /v1/decisions`, System One semantics — see src/decisions.ts).
 * Mirrors pi's `ProviderClassifierModelConfig`: `type` selects the model kind,
 * `api` must sit on the model (provider-level api is chat-only).
 */
export interface ProviderClassifierModelConfig {
	type: "classifier";
	id: string;
	name: string;
	api: "logfare-decisions";
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
}

export type ProviderModelConfig = ProviderChatModelConfig | ProviderClassifierModelConfig;

/** pi's persisted per-provider catalog entry (`context.stored` / `publish({ persist })`). */
export interface StoredCatalogEntry {
	models?: unknown[];
	checkedAt?: number;
}

export interface RefreshContext {
	stored?: StoredCatalogEntry | undefined;
	publish(publication: {
		persist?: StoredCatalogEntry | null;
		update?: (() => void) | undefined;
	}): Promise<boolean>;
	allowNetwork: boolean;
	force?: boolean | undefined;
	signal: AbortSignal;
}
