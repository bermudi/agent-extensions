/**
 * LLM Dump — Man-in-the-middle context inspector.
 *
 * Dumps exactly what the LLM sees to `.pi/llm-dump/`:
 *   - turn-{n}-messages.json   — full message array (system + context) as sent after `context` hook
 *   - turn-{n}-payload.json    — raw provider payload (serialized to provider format)
 *   - turn-{n}-system.md       — the system prompt string
 *
 * Also registers `/dump` to dump on demand and `/dump clean` to clear the dump dir.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const dumpDir = join(process.cwd(), ".pi", "llm-dump");
	let turnIndex = 0;

	function ensureDir() {
		if (!existsSync(dumpDir)) mkdirSync(dumpDir, { recursive: true });
	}

	function dump(id: string, label: string, data: unknown) {
		ensureDir();
		const file = join(dumpDir, `${id}-${label}.json`);
		writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
		return file;
	}

	// Reset turn counter each prompt
	pi.on("agent_start", () => {
		turnIndex = 0;
	});

	// 1. Dump the system prompt as the LLM sees it
	pi.on("before_agent_start", (event, ctx) => {
		const prompt = ctx.getSystemPrompt();
		ensureDir();
		writeFileSync(join(dumpDir, `turn-${turnIndex}-system.md`), prompt, "utf8");
	});

	// 2. Dump context messages after extensions have modified them
	pi.on("context", (event) => {
		dump(`turn-${turnIndex}`, "messages", event.messages);
	});

	// 3. Dump the raw provider payload (exact bytes sent to the API)
	pi.on("before_provider_request", (event) => {
		dump(`turn-${turnIndex}`, "payload", event.payload);
		turnIndex++;
	});

	// 4. Log HTTP response status for good measure
	pi.on("after_provider_response", (event, ctx) => {
		// Log to a single responses log, append mode
		ensureDir();
		const logFile = join(dumpDir, "responses.log");
		const ts = new Date().toISOString();
		const entry = `[${ts}] status=${event.status} model=${ctx.model?.id ?? "?"} headers=${JSON.stringify(event.headers)}\n`;
		writeFileSync(logFile, entry, { flag: "a" });
	});

	// /dump — dump system prompt on demand, or clean the dump dir
	pi.registerCommand("dump", {
		description: "Dump LLM context to .pi/llm-dump/ or clean it ('/dump clean')",
		handler: async (args, ctx) => {
			if (args.trim() === "clean") {
				if (existsSync(dumpDir)) {
					rmSync(dumpDir, { recursive: true, force: true });
				}
				ctx.ui.notify("Cleared .pi/llm-dump/", "info");
				return;
			}

			// On-demand dump of current state
			ensureDir();
			const prompt = ctx.getSystemPrompt();
			writeFileSync(join(dumpDir, "on-demand-system.md"), prompt, "utf8");

			const entries = ctx.sessionManager.getEntries();
			writeFileSync(
				join(dumpDir, "on-demand-entries.json"),
				JSON.stringify(entries, null, 2),
				"utf8",
			);

			const usage = ctx.getContextUsage();
			writeFileSync(
				join(dumpDir, "on-demand-usage.json"),
				JSON.stringify(usage, null, 2),
				"utf8",
			);

			ctx.ui.notify(`Dumped to .pi/llm-dump/ (${entries.length} entries, prompt ${prompt.length} chars)`, "info");
		},
	});
}
