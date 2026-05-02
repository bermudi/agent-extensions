import { describe, expect, test, afterEach } from "bun:test";
import {
	createTestSession,
	when, calls, says,
	type TestSession,
} from "@marcfargas/pi-test-harness";
import { resolve } from "node:path";
import { shuffled, fmtDuration, fmtTokens, resolveModelOrThrow, ArenaVotingUI } from "./arena.ts";

const EXTENSION = resolve(import.meta.dirname, "./arena.ts");

function getToolDef(ts: TestSession, name: string) {
	const runner = ts.session.extensionRunner;
	if (!runner) throw new Error("No extensionRunner on session");
	return runner.getToolDefinition(name);
}

// ── Pure function tests ───────────────────────────────────────────────────

describe("fmtDuration", () => {
	test("formats milliseconds", () => {
		expect(fmtDuration(42)).toBe("42ms");
		expect(fmtDuration(999)).toBe("999ms");
	});

	test("formats seconds", () => {
		expect(fmtDuration(1000)).toBe("1.0s");
		expect(fmtDuration(5500)).toBe("5.5s");
	});

	test("formats minutes+seconds", () => {
		expect(fmtDuration(60_000)).toBe("1m0s");
		expect(fmtDuration(125_000)).toBe("2m5s");
	});
});

describe("fmtTokens", () => {
	test("formats small numbers as-is", () => {
		expect(fmtTokens(0)).toBe("0");
		expect(fmtTokens(42)).toBe("42");
	});

	test("formats thousands with one decimal", () => {
		expect(fmtTokens(1000)).toBe("1.0k");
		expect(fmtTokens(5500)).toBe("5.5k");
	});

	test("formats 10k+ as rounded k", () => {
		expect(fmtTokens(10_000)).toBe("10k");
		expect(fmtTokens(42_500)).toBe("43k");
	});
});

describe("shuffled", () => {
	test("returns new array with same elements", () => {
		const input = [1, 2, 3, 4, 5];
		const result = shuffled(input);
		expect(result.length).toBe(input.length);
		expect([...result].sort()).toEqual([...input].sort());
		expect(result).not.toBe(input);
	});

	test("does not mutate original", () => {
		const input = [1, 2, 3];
		const copy = [...input];
		shuffled(input);
		expect(input).toEqual(copy);
	});

	test("all permutations possible (probabilistic)", () => {
		const perms = new Set<string>();
		for (let i = 0; i < 200; i++) {
			perms.add(shuffled([0, 1, 2]).join(","));
		}
		expect(perms.size).toBe(6);
	});

	test("handles single-element", () => {
		expect(shuffled([42])).toEqual([42]);
	});

	test("handles empty", () => {
		expect(shuffled([])).toEqual([]);
	});
});

describe("resolveModelOrThrow", () => {
	function makeRegistry(models: Array<{ provider: string; id: string }>) {
		return {
			getAvailable: () => models.map((m) => ({ ...m, provider: m.provider, id: m.id })),
			find: (provider: string, id: string) => {
				const m = models.find((m) => m.provider === provider && m.id === id);
				return m ?? undefined;
			},
		} as any;
	}

	test("resolves bare id", () => {
		const reg = makeRegistry([{ provider: "openai", id: "gpt-4.1" }]);
		const result = resolveModelOrThrow("gpt-4.1", reg);
		expect(result.id).toBe("gpt-4.1");
	});

	test("resolves provider/id", () => {
		const reg = makeRegistry([{ provider: "anthropic", id: "claude-sonnet-4" }]);
		const result = resolveModelOrThrow("anthropic/claude-sonnet-4", reg);
		expect(result.id).toBe("claude-sonnet-4");
		expect(result.provider).toBe("anthropic");
	});

	test("throws for unknown bare id", () => {
		const reg = makeRegistry([{ provider: "openai", id: "gpt-4.1" }]);
		expect(() => resolveModelOrThrow("nonexistent", reg)).toThrow("Unknown model id");
	});

	test("throws for unknown provider/id", () => {
		const reg = makeRegistry([]);
		expect(() => resolveModelOrThrow("fake/model", reg)).toThrow("Unknown model");
	});
});

// ── ArenaVotingUI ──────────────────────────────────────────────────────────

describe("ArenaVotingUI", () => {

	function mockTheme() {
		return {
			fg: (_key: string, text: string) => text,
			bg: (_key: string, text: string) => text,
			bold: (text: string) => `**${text}**`,
		} as any;
	}

	function makeResponses() {
		return [
			{ label: "Model A", identity: "a", text: "Response A", durationMs: 100, tokens: 10 },
			{ label: "Model B", identity: "b", text: "Response B", durationMs: 200, tokens: 20 },
			{ label: "Model C", identity: "c", text: "Response C", durationMs: 300, tokens: 30 },
		];
	}

	test("renders all 3 responses", () => {
		const ui = new ArenaVotingUI(makeResponses(), () => {}, () => {}, mockTheme());
		const lines = ui.render(80);
		const text = lines.join("\n");
		expect(text).toContain("Model A");
		expect(text).toContain("Model B");
		expect(text).toContain("Model C");
		expect(text).toContain("Response A");
		expect(text).toContain("Response B");
		expect(text).toContain("Response C");
	});

	test("renders vote header", () => {
		const ui = new ArenaVotingUI(makeResponses(), () => {}, () => {}, mockTheme());
		const lines = ui.render(80);
		expect(lines.join("\n")).toContain("Arena");
	});

	test("enter triggers vote for selected model", () => {
		let voted: string | undefined;
		const ui = new ArenaVotingUI(
			makeResponses(),
			(label) => { voted = label; },
			() => {},
			mockTheme(),
		);
		// Default selection is 0 = Model A
		ui.handleInput("\r"); // enter
		expect(voted).toBe("Model A");
	});

	test("arrow down moves selection", () => {
		let voted: string | undefined;
		const ui = new ArenaVotingUI(
			makeResponses(),
			(label) => { voted = label; },
			() => {},
			mockTheme(),
		);
		ui.handleInput("\x1b[B"); // down arrow
		ui.handleInput("\r"); // enter
		expect(voted).toBe("Model B");
	});

	test("escape triggers cancel", () => {
		let cancelled = false;
		const ui = new ArenaVotingUI(
			makeResponses(),
			() => {},
			() => { cancelled = true; },
			mockTheme(),
		);
		ui.handleInput("\x1b"); // escape
		expect(cancelled).toBe(true);
	});

	test("invalidate clears cache", () => {
		const ui = new ArenaVotingUI(makeResponses(), () => {}, () => {}, mockTheme());
		const first = ui.render(80);
		// Second call returns cached
		const second = ui.render(80);
		expect(second).toBe(first); // same reference
		// Invalidate and re-render
		ui.invalidate();
		const third = ui.render(80);
		expect(third).not.toBe(first);
		expect(third).toEqual(first); // same content, new array
	});

	test("truncates long responses", () => {
		const responses = [
			{ label: "Model A", identity: "a", text: "line\n".repeat(20).trimEnd(), durationMs: 100, tokens: 10 },
		];
		const ui = new ArenaVotingUI(responses, () => {}, () => {}, mockTheme());
		const lines = ui.render(80);
		const text = lines.join("\n");
		expect(text).toContain("more lines");
	});

	test("renders error state", () => {
		const responses = [
			{ label: "Model A", identity: "a", text: "", durationMs: 50, tokens: 0, error: "rate limited" },
		];
		const ui = new ArenaVotingUI(responses, () => {}, () => {}, mockTheme());
		const lines = ui.render(80);
		expect(lines.join("\n")).toContain("rate limited");
	});
});

// ── Integration: tool registration ────────────────────────────────────────

describe("arena extension integration", () => {
	let ts: TestSession | undefined;

	afterEach(() => {
		ts?.dispose();
		ts = undefined;
	});

	test("registers the arena tool", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "arena");
		expect(toolDef).toBeDefined();
		expect(toolDef!.name).toBe("arena");
		expect(toolDef!.label).toBe("Arena");
		expect(toolDef!.description).toContain("3 models");
	});

	test("has correct parameter schema", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "arena");
		const schema = toolDef!.parameters as any;
		expect(schema.type).toBe("object");
		expect(schema.properties.prompt.type).toBe("string");
		expect(schema.properties.modelA.type).toBe("string");
		expect(schema.properties.modelB.type).toBe("string");
		expect(schema.properties.modelC.type).toBe("string");
		expect(schema.required).toEqual(["prompt", "modelA", "modelB", "modelC"]);
	});

	test("execute returns error for unknown models", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "arena");

		const result = await toolDef!.execute(
			"tc-1",
			{ prompt: "hello", modelA: "a/b", modelB: "c/d", modelC: "e/f" },
			undefined,
			undefined,
			ts.session.extensionRunner as any,
		);

		const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
		expect(text).toContain("Unknown model");
	})
});

// ── Integration: renderers ────────────────────────────────────────────────

describe("arena renderers", () => {
	let ts: TestSession | undefined;

	afterEach(() => {
		ts?.dispose();
		ts = undefined;
	});

	function mockTheme() {
		return {
			fg: (_key: string, text: string) => text,
			bg: (_key: string, text: string) => text,
			bold: (text: string) => `**${text}**`,
		} as any;
	}

	test("renderCall shows 3 models", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "arena");
		const theme = mockTheme();
		const ctx = { state: {}, executionStarted: false, lastComponent: undefined, invalidate: () => {} } as any;

		const component = toolDef!.renderCall!(
			{ prompt: "test", modelA: "anthropic/claude-4", modelB: "openai/gpt-4.1", modelC: "google/gemini-2.5" },
			theme,
			ctx,
		);
		// Text component — render to get the string
		const lines = (component as any).render(80);
		const text = lines.join("\n");
		expect(text).toContain("arena");
		expect(text).toContain("anthropic/claude-4");
		expect(text).toContain("openai/gpt-4.1");
		expect(text).toContain("google/gemini-2.5");
	});

	test("renderResult shows vote winner", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "arena");
		const theme = mockTheme();
		const ctx = { state: {}, lastComponent: undefined, invalidate: () => {} } as any;

		const result = {
			content: [{ type: "text", text: "winner!" }],
			details: {
				prompt: "test",
				responses: [
					{ label: "Model A", identity: "openai/gpt-4.1", text: "response a", durationMs: 1200, tokens: 100 },
					{ label: "Model B", identity: "anthropic/claude-4", text: "response b", durationMs: 800, tokens: 90 },
					{ label: "Model C", identity: "google/gemini-2.5", text: "response c", durationMs: 1500, tokens: 120 },
				],
				vote: "Model B",
				winner: "anthropic/claude-4",
				revealed: true,
			},
		};

		const component = toolDef!.renderResult!(result, { isPartial: false, expanded: false } as any, theme, ctx);
		const lines = (component as any).render(80);
		const text = lines.join("\n");
		expect(text).toContain("Model B wins!");
		expect(text).toContain("anthropic/claude-4");
		// All identities revealed
		expect(text).toContain("openai/gpt-4.1");
		expect(text).toContain("google/gemini-2.5");
	});

	test("renderResult shows no vote cast", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "arena");
		const theme = mockTheme();
		const ctx = { state: {}, lastComponent: undefined, invalidate: () => {} } as any;

		const result = {
			content: [{ type: "text", text: "skipped" }],
			details: {
				prompt: "test",
				responses: [
					{ label: "Model A", identity: "m1", text: "ok", durationMs: 100, tokens: 10 },
				],
				revealed: false,
			},
		};

		const component = toolDef!.renderResult!(result, { isPartial: false, expanded: false } as any, theme, ctx);
		const lines = (component as any).render(80);
		const text = lines.join("\n");
		expect(text).toContain("No vote cast");
	});

	test("renderResult shows error for failed model", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "arena");
		const theme = mockTheme();
		const ctx = { state: {}, lastComponent: undefined, invalidate: () => {} } as any;

		const result = {
			content: [{ type: "text", text: "err" }],
			details: {
				prompt: "test",
				responses: [
					{ label: "Model A", identity: "m1", text: "ok", durationMs: 100, tokens: 10 },
					{ label: "Model B", identity: "m2", text: "", durationMs: 50, tokens: 0, error: "rate limited" },
				],
				vote: "Model A",
				winner: "m1",
				revealed: true,
			},
		};

		const component = toolDef!.renderResult!(result, { isPartial: false, expanded: false } as any, theme, ctx);
		const lines = (component as any).render(80);
		const text = lines.join("\n");
		expect(text).toContain("rate limited");
	});
});
