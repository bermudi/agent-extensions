/**
 * pi-session-search — Full-text search across all pi sessions.
 *
 * SQLite FTS5 index built incrementally on session_start.
 * Ctrl+F or /search opens an overlay palette to search, preview, resume, or
 * summarize past sessions into a new session.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
	updateIndex,
	rebuildIndex,
	getStats,
	closeDb,
	type SearchResult,
} from "./indexer";
import type { PaletteAction } from "./types";
import { formatDate, shortenProject } from "./types";
import { SessionSearchComponent } from "./component";
import { summarizeSession } from "./summarizer";
import { parseSearchResumePath, quoteCommandArg } from "./resume";

export default function sessionSearch(pi: ExtensionAPI): void {
	let indexReady = false;
	let indexing = false;

	// Persist pending context across extension reloads when /new is used.
	const PENDING_DIR = path.join(os.homedir(), ".pi", "agent");
	const PENDING_FILE = path.join(PENDING_DIR, ".session-search-pending.json");

	async function ensureIndex(ctx?: ExtensionContext) {
		if (indexing) return;
		indexing = true;

		try {
			await updateIndex((msg) => {
				ctx?.ui?.setStatus("session-search", `🔍 ${msg}`);
			});
			indexReady = true;
		} catch {
			// will retry on next search
		} finally {
			ctx?.ui?.setStatus("session-search", undefined);
			indexing = false;
		}
	}

	pi.on("session_start", async (event, ctx) => {
		setTimeout(() => ensureIndex(ctx), 100);

		// Inject summary into newly created sessions that were queued via "New + Context".
		// Cast needed because local dev types are older than the runtime API.
		if ((event as any).reason !== "new") return;

		try {
			const raw = await fs.readFile(PENDING_FILE, "utf8");
			const pending = JSON.parse(raw) as {
				sessionPath: string;
				project: string;
				timestamp: string;
				customPrompt?: string;
				createdAt: number;
			};

			// Ignore stale pending files (> 5 minutes)
			if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
				await fs.unlink(PENDING_FILE).catch(() => {});
				return;
			}

			await fs.unlink(PENDING_FILE).catch(() => {});

			const session = {
				sessionPath: pending.sessionPath,
				project: pending.project,
				timestamp: pending.timestamp,
			};

			const project = shortenProject(session.project, 40);
			ctx.ui.setStatus(
				"session-search",
				`🔍 Summarizing ${project}...`,
			);

			try {
				const summary = await summarizeSession(session, ctx, pending.customPrompt);

				pi.sendMessage(
					{
						customType: "session-search-context",
						content:
							`## Session Summary: ${session.project}\n` +
							`**Date:** ${formatDate(session.timestamp)} | **File:** ${session.sessionPath}\n\n` +
							summary,
						display: true,
					},
					{ triggerTurn: false },
				);
			} catch {
				// Fallback: ask the LLM to read the file directly
				pi.sendMessage(
					{
						customType: "session-search-context",
						content:
							`Summary failed. Please read this session file and summarize:\n` +
							`- **Project:** ${session.project}\n` +
							`- **Date:** ${formatDate(session.timestamp)}\n` +
							`- **Session file:** ${session.sessionPath}`,
						display: true,
					},
					{ triggerTurn: true },
				);
			} finally {
				ctx.ui.setStatus("session-search", undefined);
			}
		} catch {
			// No pending context file — normal new session
		}
	});

	pi.on("session_shutdown", async () => {
		closeDb();
	});

	// ── Open search overlay ───────────────────────────────────────────

	async function openSearch(ctx: ExtensionContext) {
		if (!indexReady && !indexing) {
			ctx.ui.setStatus("session-search", "🔍 Building index...");
			await ensureIndex(ctx);
		}

		const action = await ctx.ui.custom<PaletteAction>(
			(tui, theme, _kb, done) =>
				new SessionSearchComponent(done, tui, theme),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center" as any,
					width: 84,
				},
			},
		);

		if (action.type === "cancel") return;

		if (action.type === "resume") {
			const sessionPath = action.session.sessionPath;
			const project = shortenProject(action.session.project, 40);

			const commandCtx = ctx as ExtensionContext &
				Partial<ExtensionCommandContext>;
			if (typeof commandCtx.switchSession === "function") {
				try {
					const result = await commandCtx.switchSession(sessionPath);
					if (!result.cancelled) {
						ctx.ui.notify(`Resumed ${project}`, "info");
					}
				} catch (err) {
					ctx.ui.notify(`Resume failed: ${err}`, "error");
				}
				return;
			}

			ctx.ui.setEditorText(`/search resume ${quoteCommandArg(sessionPath)}`);
			ctx.ui.notify(
				`${project} — press Enter to resume this session`,
				"info",
			);
			return;
		}

		if (action.type === "summarize") {
			const project = shortenProject(action.session.project, 40);
			ctx.ui.setStatus(
				"session-search",
				`🔍 Summarizing ${project}...`,
			);
			ctx.ui.notify(
				`Summarizing ${project}...`,
				"info",
			);

			try {
				const summary = await summarizeSession(
					action.session,
					ctx,
					action.customPrompt,
				);

				pi.sendMessage(
					{
						customType: "session-search-context",
						content:
							`## Session Summary: ${action.session.project}\n` +
							`**Date:** ${formatDate(action.session.timestamp)} | **File:** ${action.session.sessionPath}\n\n` +
							summary,
						display: true,
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);

				ctx.ui.notify(`Summary injected from ${project}`, "info");
			} catch (err) {
				ctx.ui.notify(`Summary failed: ${err}`, "error");
			} finally {
				ctx.ui.setStatus("session-search", undefined);
			}
			return;
		}

		if (action.type === "newSession") {
			const project = shortenProject(action.session.project, 40);

			// Persist to disk so we survive the extension reload on /new.
			// session_start will pick this up in the new session.
			await fs.mkdir(PENDING_DIR, { recursive: true });
			await fs.writeFile(
				PENDING_FILE,
				JSON.stringify({
					sessionPath: action.session.sessionPath,
					project: action.session.project,
					timestamp: action.session.timestamp,
					customPrompt: action.customPrompt,
					createdAt: Date.now(),
				}),
				"utf8",
			);

			// Pre-fill /new and tell the user to press Enter
			ctx.ui.setEditorText(`/new`);
			ctx.ui.notify(
				`${project} — press Enter to start new session with context`,
				"info",
			);
			return;
		}
	}

	pi.registerCommand("search", {
		description: "Full-text search across all pi sessions",
		handler: async (args, ctx) => {
			const trimmedArgs = args?.trim() ?? "";
			const resumePath = parseSearchResumePath(trimmedArgs);

			if (resumePath !== null) {
				if (!resumePath) {
					ctx.ui.notify("Usage: /search resume <sessionPath>", "warning");
					return;
				}

				try {
					const result = await ctx.switchSession(resumePath);
					if (!result.cancelled) {
						ctx.ui.notify(`Resumed: ${resumePath}`, "info");
					}
				} catch (err) {
					ctx.ui.notify(`Resume failed: ${err}`, "error");
				}
				return;
			}

			if (trimmedArgs === "reindex") {
				ctx.ui.notify("Rebuilding index from scratch...", "info");
				indexReady = false;
				try {
					const count = await rebuildIndex((msg) =>
						ctx.ui.notify(msg, "info"),
					);
					indexReady = true;
					ctx.ui.notify(`Rebuilt index: ${count} sessions`, "info");
				} catch (err) {
					ctx.ui.notify(`Reindex failed: ${err}`, "error");
				}
				return;
			}

			if (trimmedArgs === "stats") {
				try {
					const stats = getStats();
					ctx.ui.notify(
						`Sessions: ${stats.totalSessions} | Chunks: ${stats.totalChunks} | Updated: ${stats.lastUpdated ?? "never"}`,
						"info",
					);
				} catch (err) {
					ctx.ui.notify(`Stats failed: ${err}`, "error");
				}
				return;
			}

			await openSearch(ctx as ExtensionContext);
		},
	});

	pi.registerMessageRenderer(
		"session-search-context",
		(message, options, theme) => {
			const rawContent =
				typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? (message.content as any[])
								.map((c: any) =>
									c.type === "text" ? c.text || "" : "",
								)
								.join("")
						: "";

			// Parse from "## Session Summary: project" or "**Project:** project" format
			const summaryMatch = rawContent.match(
				/Session Summary:\s*(.+)/,
			);
			const projectMatch = rawContent.match(
				/\*\*Project:\*\*\s*(.+)/,
			);
			const dateMatch = rawContent.match(
				/\*\*Date:\*\*\s*([^|*]+)/,
			);
			const project =
				summaryMatch?.[1]?.trim() ||
				projectMatch?.[1]?.trim() ||
				"session";
			const date = dateMatch?.[1]?.trim() || "";

			if (options.expanded) {
				const lines: string[] = [];
				lines.push(
					theme.fg("accent", "🔍 ") +
						theme.fg(
							"customMessageLabel",
							theme.bold("Session context: "),
						) +
						theme.fg("accent", project) +
						(date ? theme.fg("muted", ` (${date})`) : ""),
				);

				const bodyStart = rawContent.indexOf("\n\n");
				if (bodyStart >= 0) {
					const body = rawContent.slice(bodyStart + 2).trim();
					if (body) {
						lines.push("");
						lines.push(theme.fg("muted", body));
					}
				}

				return new Text(lines.join("\n"), 0, 0);
			}

			const header =
				theme.fg("accent", "🔍 ") +
				theme.fg(
					"customMessageLabel",
					theme.bold("Session context: "),
				) +
				theme.fg("accent", project) +
				(date ? theme.fg("muted", ` (${date})`) : "");

			return new Text(header, 0, 0);
		},
	);
}
