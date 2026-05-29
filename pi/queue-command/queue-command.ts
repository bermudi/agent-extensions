/**
 * Queue Command Extension
 *
 * Replaces Alt+Enter follow-up queueing with an explicit /queue command.
 * Queues a message to be sent after the current agent turn finishes.
 *
 * Usage:
 *   /queue now fix the tests
 *   /queue and then update the docs
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("queue", {
		description: "Queue a follow-up message (sent after current processing)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /queue <message>", "warning");
				return;
			}

			// Always queue as followUp — when idle, pi sends immediately anyway
			pi.sendUserMessage(text, { deliverAs: "followUp" });

			if (!ctx.isIdle()) {
				ctx.ui.notify("Queued ✓", "info");
			}
		},
	});
}
