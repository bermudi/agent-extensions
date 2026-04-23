/**
 * pi-subagents-guard
 *
 * Companion extension that wraps pi-subagents' `subagent` tool with:
 *   1. Live agent + model manifests appended to the tool description
 *   2. Pre-execution validation with helpful error messages
 *
 * How it works:
 *   - Patches pi.registerTool() before loading pi-subagents
 *   - Intercepts the "subagent" tool registration
 *   - Wraps description with live manifest, wraps execute with validation
 *   - Everything else (slash commands, status tool, event handlers) loads normally
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";

/** Known global install path for pi-subagents. One constant to maintain. */
const SUBAGENTS_ENTRY = "/home/daniel/.local/lib/node_modules/pi-subagents/index.ts";
const SUBAGENTS_NOTIFY = "/home/daniel/.local/lib/node_modules/pi-subagents/notify.ts";

/** Tool names we intercept. */
const GUARDED_TOOL = "subagent";

interface DiscoveredAgent {
	name: string;
	description: string;
}

interface DiscoveredChain {
	name: string;
	description: string;
}

/**
 * Discover agents using pi-subagents' own discoverAgents function.
 * Falls back gracefully if import fails.
 */
async function discoverAgentsList(cwd: string): Promise<{
	agents: DiscoveredAgent[];
	chains: DiscoveredChain[];
}> {
	try {
		const mod = await import("/home/daniel/.local/lib/node_modules/pi-subagents/agents.ts");
		const result = mod.discoverAgentsAll(cwd);
		return {
			agents: result.builtin
				.concat(result.user)
				.concat(result.project)
				.filter((a: { disabled?: boolean }) => a.disabled !== true)
				.map((a: { name: string; description: string }) => ({ name: a.name, description: a.description })),
			chains: result.chains.map((c: { name: string; description: string }) => ({ name: c.name, description: c.description })),
		};
	} catch (err) {
		console.error("[subagent-guard] Failed to discover agents:", err);
		return { agents: [], chains: [] };
	}
}

/**
 * Get available model IDs from the model registry.
 * Returns provider/id strings.
 */
function getAvailableModels(ctx: ExtensionContext): string[] {
	try {
		const models = ctx.modelRegistry.getAvailable();
		return models.map((m) => `${m.provider}/${m.id}`);
	} catch {
		return [];
	}
}

/**
 * Build the manifest appendix for the tool description.
 */
function buildManifestSection(agents: DiscoveredAgent[], chains: DiscoveredChain[], models: string[]): string {
	const lines: string[] = [
		"",
		"─",
		"**DISCOVERED AGENTS** (live manifest, do NOT hallucinate agent names):",
	];

	if (agents.length === 0) {
		lines.push("No agents discovered.");
	} else {
		for (const a of agents) {
			const desc = a.description.length > 80 ? a.description.slice(0, 77) + "..." : a.description;
			lines.push(`- \`${a.name}\`: ${desc}`);
		}
	}

	if (chains.length > 0) {
		lines.push("");
		lines.push("**DISCOVERED CHAINS**:");
		for (const c of chains) {
			const desc = c.description.length > 80 ? c.description.slice(0, 77) + "..." : c.description;
			lines.push(`- \`${c.name}\`: ${desc}`);
		}
	}

	if (models.length > 0) {
		lines.push("");
		lines.push("**AVAILABLE MODELS** (for model override parameter, use provider/id format):");
		// Show a reasonable number — full list can be very long
		const showModels = models.slice(0, 30);
		for (const m of showModels) {
			lines.push(`- \`${m}\``);
		}
		if (models.length > 30) {
			lines.push(`- ... and ${models.length - 30} more`);
		}
	} else {
		lines.push("");
		lines.push("_Model list unavailable — model validation skipped._");
	}

	return lines.join("\n");
}

/**
 * Validate subagent params before execution.
 * Returns an error string if validation fails, null if valid.
 */
function validateParams(
	params: Record<string, unknown>,
	knownAgents: Set<string>,
	knownChains: Set<string>,
	knownModels: Set<string>,
): string | null {
	const agentList = Array.from(knownAgents).join(", ");
	const chainList = Array.from(knownChains).join(", ");

	// Management actions pass through without agent validation
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

			// Parallel step: { parallel: [...] }
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

			// Sequential step: { agent: "..." }
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

export default async function registerGuard(pi: ExtensionAPI): Promise<void> {
	// Stash the original registerTool
	const originalRegisterTool = pi.registerTool.bind(pi);

	// State for caching discovered agents/models
	let cachedAgents: DiscoveredAgent[] = [];
	let cachedChains: DiscoveredChain[] = [];
	let cachedModels: string[] = [];
	let agentSet = new Set<string>();
	let chainSet = new Set<string>();
	let modelSet = new Set<string>();
	let manifestSection = "";

	/**
	 * Refresh the manifest from disk and (optionally) the model registry.
	 * Called eagerly at init, on session_start, and lazily on first execution.
	 */
	async function refreshManifest(cwd: string, ctx?: ExtensionContext): Promise<void> {
		const discovery = await discoverAgentsList(cwd);
		cachedAgents = discovery.agents;
		cachedChains = discovery.chains;

		// Models come from ExtensionContext which is only available at execution time
		if (ctx) {
			cachedModels = getAvailableModels(ctx);
		}

		agentSet = new Set(cachedAgents.map((a) => a.name));
		chainSet = new Set(cachedChains.map((c) => c.name));
		modelSet = new Set(cachedModels);
		manifestSection = buildManifestSection(cachedAgents, cachedChains, cachedModels);
	}

	// Eagerly populate manifest so the description is ready at registration time
	await refreshManifest(process.cwd());

	// Monkey-patch registerTool to intercept the subagent tool
	pi.registerTool = function <TParams, TDetails, TState>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void {
		if (tool.name === GUARDED_TOOL) {
			// Wrap description with live manifest
			const originalDescription = tool.description;
			const originalExecute = tool.execute;

			const wrappedTool: ToolDefinition<TParams, TDetails, TState> = {
				...tool,
				get description(): string {
					return (originalDescription as string) + manifestSection;
				},
				async execute(id, params, signal, onUpdate, ctx) {
					// Lazy refresh if we haven't discovered yet
					if (agentSet.size === 0 && !params.action) {
						await refreshManifest(ctx.cwd, ctx);
					}

					// Pre-flight validation
					const error = validateParams(
						params as unknown as Record<string, unknown>,
						agentSet,
						chainSet,
						modelSet,
					);
					if (error) {
						return {
							content: [{ type: "text" as const, text: `❌ Validation error: ${error}` }],
							isError: true,
							details: { mode: "single", results: [] } as unknown as TDetails,
						};
					}

					// Delegate to pi-subagents' original executor
					return originalExecute.call(tool, id, params, signal, onUpdate, ctx);
				},
			};

			originalRegisterTool(wrappedTool);
			return;
		}

		// All other tools (subagent_status, etc.) pass through unchanged
		originalRegisterTool(tool);
	};

	// Load pi-subagents — it will call our patched registerTool
	try {
		const { default: registerSubagentExtension } = await import(SUBAGENTS_ENTRY);
		registerSubagentExtension(pi);
	} catch (err) {
		console.error("[subagent-guard] Failed to load pi-subagents, loading unwrapped as fallback:", err);
		// Restore original registerTool and try again without wrapping
		pi.registerTool = originalRegisterTool;
		const { default: registerSubagentExtension } = await import(SUBAGENTS_ENTRY);
		registerSubagentExtension(pi);
	}

	// Load the notify extension too (it's listed in pi-subagents' package.json)
	try {
		const { default: registerNotify } = await import(SUBAGENTS_NOTIFY);
		registerNotify(pi);
	} catch (err) {
		console.error("[subagent-guard] Failed to load pi-subagents notify extension:", err);
	}

	// Pre-populate manifest on session start
	pi.on("session_start", async (_event, ctx) => {
		await refreshManifest(ctx.cwd, ctx);
	});
}
