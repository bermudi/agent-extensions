import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fetchCatalog, isCatalogFresh, LOGFARE_BASE_URL } from "./catalog.ts";
import { logfareClassifiers } from "./decisions.ts";
import baselineModels from "./baseline.json" with { type: "json" };
import { catalogToProviderModels } from "./transform.ts";
import type {
	LogfareCatalogEntry,
	ProviderModelConfig,
	RefreshContext,
} from "./types.ts";

const PROVIDER_ID = "logfare";
const PROVIDER_NAME = "Logfare";

/**
 * Env-gated debug trace for "why isn't my logfare list updating" sessions.
 * Off by default; refresh errors always surface through pi regardless.
 */
const DEBUG_LOG =
	process.env.PI_LOGFARE_DEBUG === undefined ? undefined : `${tmpdir()}/pi-logfare-debug.log`;
function debug(line: string): void {
	if (DEBUG_LOG) {
		try {
			appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
		} catch {
			// never break registration over debug logging
		}
	}
}

/**
 * The pass-keys command reader resolves at request time, exactly like the old
 * models.json entry. Never inline a key here.
 */
const API_KEY_READER = "!pass-keys get pi LOGFARE_API_KEY";

/**
 * Frozen 2026-10-22 snapshot of the hand-maintained block, used until the first
 * successful refresh persists a live catalog (first boot offline, print-mode
 * sessions that never open the model picker).
 */
const BASELINE_MODELS = baselineModels as ProviderModelConfig[];

function storedModels(stored: RefreshContext["stored"]): ProviderModelConfig[] | undefined {
	const models = (stored?.models ?? []).filter(
		(m): m is ProviderModelConfig => !!m && typeof (m as ProviderModelConfig).id === "string",
	);
	return models.length > 0 ? models : undefined;
}

/**
 * Refresh contract (mirrors pi's built-in remote catalogs):
 * restore-only phases and fresh windows return the last persisted list;
 * otherwise fetch, persist, and return the live list; failures throw so pi
 * surfaces the error while the previously registered models stay in place.
 */
export async function refreshModels(
	context: RefreshContext,
	fetch: (signal: AbortSignal) => Promise<LogfareCatalogEntry[]> = fetchCatalog,
): Promise<ProviderModelConfig[]> {
	debug(`refresh called: allowNetwork=${context.allowNetwork} force=${String(context.force)} storedModels=${context.stored?.models?.length ?? "none"} checkedAt=${String(context.stored?.checkedAt)} aborted=${String(context.signal.aborted)}`);
	const lastGood = storedModels(context.stored) ?? BASELINE_MODELS;
	if (!context.allowNetwork || context.signal.aborted || isCatalogFresh(context.stored?.checkedAt, context.force === true)) {
		debug(`restore-only/fresh path (noNet=${!context.allowNetwork} aborted=${String(context.signal.aborted)} fresh=${isCatalogFresh(context.stored?.checkedAt, context.force === true)}), returning ${lastGood.length} models`);
		return lastGood;
	}
	try {
		const models = catalogToProviderModels(await fetch(context.signal));
		const published = await context.publish({ persist: { models, checkedAt: Date.now() } });
		debug(`fetched+published ${models.length} models, publish=${published}`);
		return models;
	} catch (err) {
		debug(`refresh failed: ${String(err)}`);
		if (context.stored) {
			// Move the freshness window so a dead upstream is retried at the
			// refresh cadence, not on every picker open.
			await context.publish({ persist: { models: context.stored.models ?? [], checkedAt: Date.now() } });
		}
		throw new Error(`pi-logfare: catalog refresh failed, keeping last-known list: ${String(err)}`);
	}
}

export function registerLogfareProvider(pi: {
	registerProvider(name: string, config: Record<string, unknown>): void;
}): void {
	debug("registering logfare provider");
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: LOGFARE_BASE_URL,
		api: "openai-completions",
		apiKey: API_KEY_READER,
		authHeader: true,
		models: BASELINE_MODELS,
		classifiers: logfareClassifiers,
		refreshModels,
	});
}
