import * as fs from "node:fs";

/**
 * Parse a JSONL session file into an array of message objects
 * suitable for consumption by groupIntoTurns().
 */
export function parseSessionMessages(sessionPath: string): Record<string, any>[] {
	const data = fs.readFileSync(sessionPath, "utf-8");
	const messages: Record<string, any>[] = [];

	for (const line of data.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "message" && entry.message) {
			messages.push(entry.message);
		}
	}

	return messages;
}
