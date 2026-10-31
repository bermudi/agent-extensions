import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { catalogToClassifierModel, catalogToProviderModel, catalogToProviderModels, isChatEntry, isDecisionsEntry } from "../src/transform.ts";
import type { LogfareCatalogEntry, ProviderModelConfig } from "../src/types.ts";

const fixture: LogfareCatalogEntry[] = JSON.parse(
	readFileSync(new URL("./fixtures/logfare-catalog.json", import.meta.url), "utf8"),
).data;
const baseline: ProviderModelConfig[] = JSON.parse(
	readFileSync(new URL("../src/baseline.json", import.meta.url), "utf8"),
);

test("transform reproduces the hand-maintained baseline exactly from the pinned live catalog", () => {
	const got = catalogToProviderModels(fixture);
	assert.deepEqual(got, baseline);
});

test("non-chat catalog entries are filtered out of the chat list", () => {
	const chat = fixture.filter(isChatEntry).map((e) => e.id);
	assert.equal(chat.length, baseline.filter((m) => !("type" in m)).length);
	assert.equal(chat.length, 25);
	assert.ok(!chat.includes("text-embedding-3-small"));
	assert.ok(!chat.includes("flux-2-dev"));
	assert.ok(!chat.includes("whisper-large-v3-turbo"));
	assert.ok(!chat.includes("clef"));
});

test("decisions entries become codemode classifier models", () => {
	const decisions = fixture.filter(isDecisionsEntry).map((e) => e.id).sort();
	assert.deepEqual(decisions, ["8ball", "clef", "clef-flash"]);

	const clef = catalogToClassifierModel(fixture.find((e) => e.id === "clef")!);
	assert.deepEqual(clef, {
		type: "classifier",
		id: "clef",
		name: "Clef",
		api: "logfare-decisions",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65537,
	});

	const flash = catalogToClassifierModel(fixture.find((e) => e.id === "clef-flash")!);
	assert.equal(flash.contextWindow, 24576);
	assert.equal(flash.name, "Clef Flash");

	// Metadata-less decisions entries take the same conservative defaults as chat ones.
	const eightball = catalogToClassifierModel(fixture.find((e) => e.id === "8ball")!);
	assert.equal(eightball.contextWindow, 32768);
	assert.deepEqual(eightball.input, ["text"]);

	// The full transform carries chat + classifier models, sorted by id.
	assert.equal(catalogToProviderModels(fixture).length, 28);
});

test("metadata-less entries take conservative defaults", () => {
	const auto = catalogToProviderModel(fixture.find((e) => e.id === "logfare/auto")!);
	assert.equal(auto.contextWindow, 32768);
	assert.deepEqual(auto.input, ["text"]);
	assert.equal(auto.compat, null);
	assert.equal(auto.thinkingLevelMap, null);
	// Hand override: the router routes to reasoning models.
	assert.equal(auto.reasoning, true);
});

test("reasoning is keyed on reasoning_effort, not the bare reasoning tag", () => {
	// kimi and gemma carry a "reasoning" tag in supported_parameters but no
	// reasoning_effort — the hand block treats both as non-reasoning.
	const kimi = catalogToProviderModel(fixture.find((e) => e.id === "kimi-k2.6")!);
	assert.equal(kimi.reasoning, false);
	const gemma = catalogToProviderModel(fixture.find((e) => e.id === "gemma-4-26b")!);
	assert.equal(gemma.reasoning, false);
	const glm = catalogToProviderModel(fixture.find((e) => e.id === "glm-5.3")!);
	assert.equal(glm.reasoning, true);
});

test("pi-incompatible input modalities are dropped, text ordered first", () => {
	const minimax = catalogToProviderModel(fixture.find((e) => e.id === "minimax-m3.1-flash")!);
	assert.deepEqual(minimax.input, ["text", "image"]);
});

test("placeholder maxTokens and zero cost stand in for unpublished catalog fields", () => {
	const gpt4o = catalogToProviderModel(fixture.find((e) => e.id === "gpt-4o")!);
	assert.equal(gpt4o.maxTokens, 16384);
	assert.deepEqual(gpt4o.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("thinking maps follow the model family", () => {
	const maps = Object.fromEntries(
		baseline.map((m) => [m.id, m.type === "classifier" ? null : (m.thinkingLevelMap ?? null)]),
	);
	assert.deepEqual(maps["glm-5.3"], { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
	assert.deepEqual(maps["gpt-5-mini"], { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null });
	assert.deepEqual(maps["deepseek-v4-pro-0813"], { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
});

test("gpt-5.2-chat keeps its verified max_completion_tokens override", () => {
	const gpt52 = catalogToProviderModel(fixture.find((e) => e.id === "gpt-5.2-chat")!);
	assert.equal(gpt52.compat?.maxTokensField, "max_completion_tokens");
});
