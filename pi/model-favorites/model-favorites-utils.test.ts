import { describe, expect, test } from "bun:test";

import {
	countHiddenFavorites,
	modelKey,
	orderModelsForSelector,
	partitionOrderedModels,
	recordRecentKeys,
	toggleFavoriteKeys,
	type ModelLike,
} from "./model-favorites-utils";

const MODELS: ModelLike[] = [
	{ provider: "openai", id: "gpt-5" },
	{ provider: "anthropic", id: "claude-sonnet-4-5" },
	{ provider: "google", id: "gemini-2.5-pro" },
	{ provider: "openrouter", id: "qwen/qwen3-coder" },
];

describe("model favorites utils", () => {
	test("modelKey joins provider and id", () => {
		expect(modelKey({ provider: "openai", id: "gpt-5" })).toBe("openai/gpt-5");
	});

	test("toggleFavoriteKeys adds new favorites to the front and removes existing ones", () => {
		expect(toggleFavoriteKeys([], "openai/gpt-5")).toEqual(["openai/gpt-5"]);
		expect(toggleFavoriteKeys(["openai/gpt-5", "anthropic/claude-sonnet-4-5"], "openai/gpt-5")).toEqual([
			"anthropic/claude-sonnet-4-5",
		]);
	});

	test("recordRecentKeys deduplicates and caps the recent list", () => {
		expect(recordRecentKeys(["b", "a"], "a", 3)).toEqual(["a", "b"]);
		expect(recordRecentKeys(["b", "c", "d"], "a", 3)).toEqual(["a", "b", "c"]);
	});

	test("orderModelsForSelector prioritizes favorites, then recents, then current, then alphabetical", () => {
		const ordered = orderModelsForSelector(
			MODELS,
			["google/gemini-2.5-pro", "anthropic/claude-sonnet-4-5"],
			["openrouter/qwen/qwen3-coder", "openai/gpt-5"],
			"openai/gpt-5",
		).map((model) => modelKey(model));

		expect(ordered).toEqual([
			"google/gemini-2.5-pro",
			"anthropic/claude-sonnet-4-5",
			"openrouter/qwen/qwen3-coder",
			"openai/gpt-5",
		]);
	});

	test("partitionOrderedModels preserves order while grouping favorites and recents", () => {
		const ordered = orderModelsForSelector(
			MODELS,
			["anthropic/claude-sonnet-4-5"],
			["openrouter/qwen/qwen3-coder"],
		);
		const sections = partitionOrderedModels(ordered, ["anthropic/claude-sonnet-4-5"], ["openrouter/qwen/qwen3-coder"]);

		expect(sections.favorites.map((model) => modelKey(model))).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(sections.recent.map((model) => modelKey(model))).toEqual(["openrouter/qwen/qwen3-coder"]);
		expect(sections.others.map((model) => modelKey(model))).toEqual([
			"google/gemini-2.5-pro",
			"openai/gpt-5",
		]);
	});

	test("countHiddenFavorites reports favorites missing from the available model list", () => {
		expect(countHiddenFavorites(MODELS.slice(0, 2), ["openai/gpt-5", "google/gemini-2.5-pro", "missing/model"])).toBe(2);
	});
});
