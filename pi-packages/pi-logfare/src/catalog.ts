import type { LogfareCatalog, LogfareCatalogEntry } from "./types.ts";

export const LOGFARE_BASE_URL = "https://logfare.ai/v1";
export const CATALOG_URL = "https://logfare.ai/v1/models";

/**
 * Skip the network when the persisted catalog was checked within this window —
 * the same cadence pi's built-in remote catalogs use. Catalog churn is daily at
 * most; a stale-by-hours list is not worth a request on every picker open.
 */
export const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Bound one catalog attempt; matches pi's REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS. */
const FETCH_TIMEOUT_MS = 4000;

export function isCatalogFresh(storedCheckedAt: number | undefined, force: boolean): boolean {
	return (
		!force &&
		storedCheckedAt !== undefined &&
		Date.now() - storedCheckedAt < REFRESH_INTERVAL_MS
	);
}

/**
 * Fetch and validate the public catalog. No auth required; never send keys.
 * Throws with context on any failure — callers keep their last-good list.
 */
export async function fetchCatalog(signal: AbortSignal): Promise<LogfareCatalogEntry[]> {
	const response = await fetch(CATALOG_URL, {
		headers: { accept: "application/json" },
		signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
	});
	if (!response.ok) {
		throw new Error(`pi-logfare: catalog request failed: HTTP ${response.status}`);
	}
	const body = (await response.json()) as LogfareCatalog;
	if (body.object !== "list" || !Array.isArray(body.data)) {
		throw new Error("pi-logfare: catalog response is not a model list");
	}
	return body.data;
}
