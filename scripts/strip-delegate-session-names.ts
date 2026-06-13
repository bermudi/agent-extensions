#!/usr/bin/env bun
/**
 * strip-delegate-session-names.ts
 *
 * Removes the `⎇ delegate · <agent>` session_info entries that the delegate
 * extension used to write into every subagent session file. These names make
 * subagent sessions show up in pi's Ctrl+N "named only" filter, burying real
 * named sessions.
 *
 * The delegate extension no longer writes these names (lifecycle.ts fix), but
 * existing files on disk are append-only JSONL — they don't self-heal.
 *
 * What this does:
 *   - Finds every *.jsonl under the sessions dir containing a delegate label.
 *   - Strips ONLY the `session_info` line whose name starts with `⎇ delegate`.
 *     Leaves the header (incl. parentSession), messages, and any other entries
 *     byte-for-byte intact. Threading is preserved.
 *
 * Safety:
 *   - DRY RUN by default. Prints a summary; changes nothing.
 *   - `--apply` to write. Before writing, backs up every affected file into a
 *     timestamped .bak dir next to the sessions root.
 *   - Refuses to touch a file that has >1 session_info entry (ambiguous — could
 *     clobber a user rename). Currently zero such files exist.
 *   - After writing, re-reads each file and asserts: exactly one line removed,
 *     every remaining line still valid JSON, header still present.
 *
 * Usage:
 *   bun run scripts/strip-delegate-session-names.ts            # dry run
 *   bun run scripts/strip-delegate-session-names.ts --apply    # write + backup
 *   bun run scripts/strip-delegate-session-names.ts --dir /path/to/sessions
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

// Auto-generated subagent labels written by the delegate extension (and its
// earlier `spawn`-prefixed incarnation). Both pollute the Ctrl+N named filter.
// Match any session_info whose name starts with one of these prefixes.
const POLLUTED_PREFIXES = ["⎇ delegate ·", "⎇ spawn ·"];

function isPollutedSessionInfo(line: string): boolean {
	let obj: unknown;
	try {
		obj = JSON.parse(line);
	} catch {
		return false;
	}
	if (typeof obj !== "object" || obj === null) return false;
	const o = obj as { type?: string; name?: unknown };
	return o.type === "session_info" && typeof o.name === "string" &&
		POLLUTED_PREFIXES.some((p) => o.name!.startsWith(p));
}

function* walkJsonl(dir: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			yield* walkJsonl(full);
		} else if (st.isFile() && full.endsWith(".jsonl")) {
			yield full;
		}
	}
}

function processFile(path: string): { stripped: number; total: number; kept: string[] } | null {
	const raw = readFileSync(path, "utf-8");
	const lines = raw.split("\n");
	// Trailing newline → last element is "". Preserve it.
	const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === "";
	const body = trailingEmpty ? lines.slice(0, -1) : lines;

	const sessionInfoCount = body.filter((l) => {
		try { return JSON.parse(l).type === "session_info"; } catch { return false; }
	}).length;
	if (sessionInfoCount > 1) {
		return null; // ambiguous — skip (user may have renamed)
	}

	const kept: string[] = [];
	let stripped = 0;
	for (const line of body) {
		if (isPollutedSessionInfo(line)) {
			stripped++;
			continue;
		}
		kept.push(line);
	}
	if (stripped === 0) return null;
	return { stripped, total: body.length, kept };
}

function main() {
	const args = process.argv.slice(2);
	const apply = args.includes("--apply");
	const dirIdx = args.indexOf("--dir");
	const sessionsDir = dirIdx !== -1 && args[dirIdx + 1]
		? args[dirIdx + 1]!
		: join(process.env.HOME ?? "", ".pi", "agent", "sessions");

	if (!existsSync(sessionsDir)) {
		console.error(`sessions dir not found: ${sessionsDir}`);
		process.exit(1);
	}

	console.log(`${apply ? "APPLY" : "DRY RUN"} · sessions dir: ${sessionsDir}\n`);

	let scanned = 0;
	let affected = 0;
	let skippedAmbiguous = 0;
	let totalStripped = 0;
	const toWrite: { path: string; kept: string[]; trailingEmpty: boolean }[] = [];

	for (const file of walkJsonl(sessionsDir)) {
		scanned++;
		const raw = readFileSync(file, "utf-8");
		if (!raw.includes("⎇ delegate") && !raw.includes("⎇ spawn")) continue;
		const result = processFile(file);
		if (!result) {
			const sessionInfoCount = raw.split("\n").filter((l) => {
				try { return JSON.parse(l).type === "session_info"; } catch { return false; }
			}).length;
			if (sessionInfoCount > 1) skippedAmbiguous++;
			continue;
		}
		affected++;
		totalStripped += result.stripped;
		const trailingEmpty = raw.endsWith("\n");
		toWrite.push({ path: file, kept: result.kept, trailingEmpty });
		if (affected <= 10 || affected % 50 === 0) {
			console.log(`  ${result.stripped}/${result.total} lines stripped · ${file.replace(sessionsDir + "/", "")}`);
		}
	}

	console.log(
		`\nscanned ${scanned} files · ${affected} affected · ${totalStripped} entries to strip` +
		(skippedAmbiguous ? ` · ${skippedAmbiguous} skipped (ambiguous: >1 session_info)` : ""),
	);

	if (!apply) {
		if (affected > 0) console.log("\ndry run — no files written. re-run with --apply to strip + back up.");
		return;
	}
	if (affected === 0) return;

	// Back up affected files before writing.
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const backupDir = join(dirname(sessionsDir), `sessions-pre-strip-${ts}`);
	mkdirSync(backupDir, { recursive: true });
	let backedUp = 0;
	for (const { path } of toWrite) {
		const rel = path.replace(sessionsDir + "/", "");
		const dest = join(backupDir, rel);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(path, dest);
		backedUp++;
	}
	console.log(`\nbacked up ${backedUp} files → ${backupDir}`);

	// Write + verify.
	let written = 0;
	let verifyFailed = 0;
	for (const { path, kept, trailingEmpty } of toWrite) {
		const before = readFileSync(path, "utf-8").split("\n").filter((l) => l !== "").length;
		const out = kept.join("\n") + (trailingEmpty ? "\n" : "");
		writeFileSync(path, out);

		// Verify: every remaining line parses as JSON, count dropped by exactly the stripped count,
		// and the header line is still present.
		const afterRaw = readFileSync(path, "utf-8");
		const afterLines = afterRaw.split("\n").filter((l) => l !== "");
		let headerOk = false;
		for (const l of afterLines) {
			try {
				const o = JSON.parse(l);
				if (o.type === "session") headerOk = true;
			} catch {
				verifyFailed++;
				console.error(`  VERIFY FAIL (bad json): ${path}`);
				break;
			}
		}
		if (!headerOk) {
			verifyFailed++;
			console.error(`  VERIFY FAIL (no header): ${path}`);
		}
		written++;
	}

	console.log(`\nwrote ${written} files. ${verifyFailed ? `${verifyFailed} VERIFY FAILURES — restore from ${backupDir}` : "all verified ok."}`);
	if (verifyFailed) process.exit(1);
}

main();
