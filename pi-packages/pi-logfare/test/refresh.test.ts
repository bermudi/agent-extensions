import assert from "node:assert/strict";
import test from "node:test";
import { refreshModels } from "../src/register.ts";
import baseline from "../src/baseline.json" with { type: "json" };
import { catalogToProviderModels } from "../src/transform.ts";
import type { LogfareCatalogEntry, ProviderModelConfig, RefreshContext } from "../src/types.ts";

const BASELINE = baseline as ProviderModelConfig[];
const FETCHED: LogfareCatalogEntry[] = [
	{ id: "live-model", display_name: "Live Model", endpoints: ["chat/completions"] },
	{
		id: "live-clef",
		display_name: "Live Clef",
		endpoints: ["decisions"],
		architecture: { input_modalities: ["text", "image"], output_modalities: ["decisions"] },
		context_length: 4242,
	},
];
const LIVE = catalogToProviderModels(FETCHED);

function makeContext(overrides: Partial<RefreshContext> = {}): RefreshContext & { persisted: unknown[] } {
	const persisted: unknown[] = [];
	return {
		persisted,
		stored: undefined,
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async (publication) => {
			if (publication.persist !== undefined) persisted.push(publication.persist);
			if (publication.update) publication.update();
			return true;
		},
		...overrides,
	};
}

const fetchOK = async () => FETCHED;
const fetchDead = async () => {
	throw new Error("connection refused");
};

test("restore-only phase (no network) returns stored list, then baseline before first refresh", async () => {
	const stored = makeContext({ allowNetwork: false, stored: { models: LIVE, checkedAt: 1 } });
	assert.deepEqual(await refreshModels(stored, fetchDead), LIVE);

	const empty = makeContext({ allowNetwork: false });
	assert.deepEqual(await refreshModels(empty, fetchDead), BASELINE);
});

test("fresh persisted catalog skips the network until the window passes or force is set", async () => {
	const fresh = makeContext({ stored: { models: LIVE, checkedAt: Date.now() } });
	assert.deepEqual(await refreshModels(fresh, fetchOK), LIVE);
	assert.equal(fresh.persisted.length, 0);

	const forced = makeContext({ stored: { models: LIVE, checkedAt: Date.now() }, force: true });
	assert.deepEqual(await refreshModels(forced, fetchOK), LIVE);
	assert.equal(forced.persisted.length, 1);
});

test("successful refresh returns live models and persists them with checkedAt", async () => {
	const ctx = makeContext();
	const models = await refreshModels(ctx, fetchOK);
	assert.deepEqual(models, LIVE);
	assert.equal(ctx.persisted.length, 1);
	const entry = ctx.persisted[0] as { models: ProviderModelConfig[]; checkedAt: number };
	assert.deepEqual(entry.models, LIVE);
	assert.ok(typeof entry.checkedAt === "number");
	// Decisions entries ride along as classifier models through every path.
	const liveClef = LIVE.find((m): m is Extract<ProviderModelConfig, { type: "classifier" }> => m.type === "classifier");
	assert.ok(liveClef);
	assert.equal(liveClef.id, "live-clef");
	assert.equal(liveClef.api, "logfare-decisions");
});

test("failed refresh with stored state keeps last-good list and moves the freshness window", async () => {
	const stored = { models: LIVE, checkedAt: 1 };
	const ctx = makeContext({ stored });
	await assert.rejects(refreshModels(ctx, fetchDead), /pi-logfare: catalog refresh failed/);
	// In-memory list untouched (no update published), but checkedAt moved.
	assert.deepEqual(ctx.persisted, [{ models: LIVE, checkedAt: ctx.persisted[0] && (ctx.persisted[0] as { checkedAt: number }).checkedAt }]);
	assert.ok((ctx.persisted[0] as { checkedAt: number }).checkedAt > 1);
});

test("failed refresh without stored state throws; baseline registration stays intact", async () => {
	const ctx = makeContext();
	await assert.rejects(refreshModels(ctx, fetchDead), /pi-logfare: catalog refresh failed/);
	assert.equal(ctx.persisted.length, 0);
});
