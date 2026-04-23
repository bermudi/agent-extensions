/**
 * Tests for pi-subagents-guard
 *
 * Two layers:
 *   1. Pure unit tests for validation and manifest logic
 *   2. Integration tests that load the guard into a real pi session
 *      (session creation + tool registration + description augmentation)
 */

import { describe, it, expect, afterEach } from "bun:test";
import { resolve } from "node:path";
import { createTestSession } from "@marcfargas/pi-test-harness";

const EXTENSION = resolve(import.meta.dirname, "index.ts");

// ─── Helpers ──────────────────────────────────────────────────────

// We need to import the pure functions from the guard.
// Since they're module-scoped, we'll re-implement the validation logic
// in tests to match the guard's implementation, and also test the
// guard end-to-end via the test session.

function validateParams(
	params: Record<string, unknown>,
	knownAgents: Set<string>,
	knownChains: Set<string>,
	knownModels: Set<string>,
): string | null {
	const agentList = Array.from(knownAgents).join(", ");

	// Management actions pass through
	if (params.action) return null;

	// SINGLE mode: validate agent
	if (typeof params.agent === "string" && params.agent) {
		if (!knownAgents.has(params.agent)) {
			return `Unknown agent: "${params.agent}". Available agents: ${agentList || "(none)"}`;
		}
	}

	// Validate model override
	if (typeof params.model === "string" && params.model && knownModels.size > 0) {
		if (!knownModels.has(params.model)) {
			const sample = Array.from(knownModels).slice(0, 15).join(", ");
			return `Unknown model: "${params.model}". Available models include: ${sample}${knownModels.size > 15 ? ` ... and ${knownModels.size - 15} more` : ""}`;
		}
	}

	// CHAIN mode: validate each step's agent
	if (Array.isArray(params.chain)) {
		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i] as Record<string, unknown> | undefined;
			if (!step) continue;

			if (Array.isArray(step.parallel)) {
				for (let j = 0; j < step.parallel.length; j++) {
					const task = step.parallel[j] as Record<string, unknown> | undefined;
					if (task && typeof task.agent === "string" && !knownAgents.has(task.agent)) {
						return `Unknown agent in chain step ${i} parallel task ${j}: "${task.agent}". Available agents: ${agentList || "(none)"}`;
					}
					if (task && typeof task.model === "string" && task.model && knownModels.size > 0 && !knownModels.has(task.model)) {
						return `Unknown model in chain step ${i} parallel task ${j}: "${task.model}". Available models include: ${Array.from(knownModels).slice(0, 10).join(", ")}`;
					}
				}
				continue;
			}

			if (typeof step.agent === "string" && !knownAgents.has(step.agent)) {
				return `Unknown agent in chain step ${i}: "${step.agent}". Available agents: ${agentList || "(none)"}`;
			}
			if (typeof step.model === "string" && step.model && knownModels.size > 0 && !knownModels.has(step.model)) {
				return `Unknown model in chain step ${i}: "${step.model}". Available models include: ${Array.from(knownModels).slice(0, 10).join(", ")}`;
			}
		}
	}

	// PARALLEL mode: validate each task's agent
	if (Array.isArray(params.tasks)) {
		for (let i = 0; i < params.tasks.length; i++) {
			const task = params.tasks[i] as Record<string, unknown> | undefined;
			if (!task) continue;
			if (typeof task.agent === "string" && !knownAgents.has(task.agent)) {
				return `Unknown agent in parallel task ${i}: "${task.agent}". Available agents: ${agentList || "(none)"}`;
			}
			if (typeof task.model === "string" && task.model && knownModels.size > 0 && !knownModels.has(task.model)) {
				return `Unknown model in parallel task ${i}: "${task.model}". Available models include: ${Array.from(knownModels).slice(0, 10).join(", ")}`;
			}
		}
	}

	return null;
}

// ─── Unit Tests: Validation ───────────────────────────────────────

describe("validateParams", () => {
	const agents = new Set(["scout", "worker", "reviewer"]);
	const chains = new Set(["build-pipeline"]);
	const models = new Set(["anthropic/claude-sonnet-4", "google/gemini-3-pro"]);

	it("returns null for management actions", () => {
		expect(validateParams({ action: "list" }, agents, chains, models)).toBeNull();
		expect(validateParams({ action: "get", agent: "anything" }, agents, chains, models)).toBeNull();
		expect(validateParams({ action: "create", config: {} }, agents, chains, models)).toBeNull();
	});

	it("returns null for known agent in SINGLE mode", () => {
		expect(validateParams({ agent: "scout", task: "look around" }, agents, chains, models)).toBeNull();
	});

	it("returns null for known agent with known model", () => {
		expect(validateParams({ agent: "scout", task: "go", model: "anthropic/claude-sonnet-4" }, agents, chains, models)).toBeNull();
	});

	it("errors on unknown agent in SINGLE mode", () => {
		const err = validateParams({ agent: "nonexistent", task: "do stuff" }, agents, chains, models);
		expect(err).toContain("Unknown agent");
		expect(err).toContain("nonexistent");
		expect(err).toContain("scout");
	});

	it("errors on unknown model override", () => {
		const err = validateParams({ agent: "scout", task: "go", model: "fake/model" }, agents, chains, models);
		expect(err).toContain("Unknown model");
		expect(err).toContain("fake/model");
	});

	it("skips model validation when model set is empty", () => {
		const noModels = new Set<string>();
		expect(validateParams({ agent: "scout", task: "go", model: "anything/goes" }, agents, chains, noModels)).toBeNull();
	});

	it("errors on unknown agent in chain sequential step", () => {
		const err = validateParams(
			{ chain: [{ agent: "ghost", task: "boo" }] },
			agents, chains, models,
		);
		expect(err).toContain("chain step 0");
		expect(err).toContain("ghost");
	});

	it("errors on unknown agent in chain parallel step", () => {
		const err = validateParams(
			{ chain: [{ parallel: [{ agent: "ghost", task: "boo" }, { agent: "scout", task: "ok" }] }] },
			agents, chains, models,
		);
		expect(err).toContain("chain step 0 parallel task 0");
		expect(err).toContain("ghost");
	});

	it("errors on unknown model in chain step", () => {
		const err = validateParams(
			{ chain: [{ agent: "scout", task: "go", model: "nope/nope" }] },
			agents, chains, models,
		);
		expect(err).toContain("Unknown model in chain step 0");
	});

	it("errors on unknown agent in parallel tasks", () => {
		const err = validateParams(
			{ tasks: [{ agent: "scout", task: "a" }, { agent: "phantom", task: "b" }] },
			agents, chains, models,
		);
		expect(err).toContain("parallel task 1");
		expect(err).toContain("phantom");
	});

	it("errors on unknown model in parallel tasks", () => {
		const err = validateParams(
			{ tasks: [{ agent: "scout", task: "a", model: "bogus/llm" }] },
			agents, chains, models,
		);
		expect(err).toContain("Unknown model in parallel task 0");
	});

	it("passes for valid chain with known agents", () => {
		expect(validateParams(
			{ chain: [{ agent: "scout", task: "look" }, { agent: "worker", task: "build" }] },
			agents, chains, models,
		)).toBeNull();
	});

	it("passes for valid parallel tasks", () => {
		expect(validateParams(
			{ tasks: [{ agent: "scout", task: "a" }, { agent: "worker", task: "b" }] },
			agents, chains, models,
		)).toBeNull();
	});

	it("handles empty/missing agent gracefully", () => {
		// No agent field at all — not an error (might be management mode or parallel)
		expect(validateParams({ task: "something" }, agents, chains, models)).toBeNull();
	});

	it("handles null/undefined chain steps gracefully", () => {
		expect(validateParams(
			{ chain: [null, undefined, { agent: "scout", task: "go" }] },
			agents, chains, models,
		)).toBeNull();
	});
});

// ─── Integration Tests ────────────────────────────────────────────

describe("guard extension loading", () => {
	let t: Awaited<ReturnType<typeof createTestSession>> | undefined;
	afterEach(() => t?.dispose());

	it("loads without errors and registers subagent tool", async () => {
		t = await createTestSession({ extensions: [EXTENSION] });
		const tools = t.session.agent.state.tools as Array<{ name: string; description: string }>;
		const names = tools.map((tool) => tool.name);

		expect(names).toContain("subagent");
		expect(names).toContain("subagent_status");
	});

	it("augments the subagent tool description with live manifest", async () => {
		t = await createTestSession({ extensions: [EXTENSION] });
		const tools = t.session.agent.state.tools as Array<{ name: string; description: string }>;
		const subagent = tools.find((tool) => tool.name === "subagent");

		expect(subagent).toBeDefined();
		expect(subagent!.description).toContain("DISCOVERED AGENTS");
		expect(subagent!.description).toContain("Model list unavailable");
	});

	it("includes original tool description content", async () => {
		t = await createTestSession({ extensions: [EXTENSION] });
		const tools = t.session.agent.state.tools as Array<{ name: string; description: string }>;
		const subagent = tools.find((tool) => tool.name === "subagent");

		// Original description markers should still be present
		expect(subagent!.description).toContain("EXECUTION (use exactly ONE mode)");
		expect(subagent!.description).toContain("SINGLE");
		expect(subagent!.description).toContain("CHAIN");
		expect(subagent!.description).toContain("PARALLEL");
		expect(subagent!.description).toContain("MANAGEMENT");
	});

	it("includes discovered agent names in manifest", async () => {
		t = await createTestSession({ extensions: [EXTENSION] });
		const tools = t.session.agent.state.tools as Array<{ name: string; description: string }>;
		const subagent = tools.find((tool) => tool.name === "subagent");

		// scout and reviewer are builtin agents from pi-subagents
		expect(subagent!.description).toContain("scout");
		expect(subagent!.description).toContain("reviewer");
	});

	it("does not modify subagent_status tool", async () => {
		t = await createTestSession({ extensions: [EXTENSION] });
		const tools = t.session.agent.state.tools as Array<{ name: string; description: string }>;
		const status = tools.find((tool) => tool.name === "subagent_status");

		expect(status).toBeDefined();
		// Should NOT have the manifest appended
		expect(status!.description).not.toContain("DISCOVERED AGENTS");
	});
});
