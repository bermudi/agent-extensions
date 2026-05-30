/**
 * /retry — invisible continue
 *
 * When the model's turn fails (API timeout, connection error, etc), you'd
 * normally have to type "continue" — which the model sees and interprets as
 * instruction, potentially derailing its train of thought.
 *
 * /retry triggers a new turn without adding any visible message to the LLM
 * context. The model just picks up where it left off, unaware anything happened.
 *
 * How it works:
 *   1. Sends a custom message with triggerTurn to start a new agent turn
 *   2. The context event strips that message before it reaches the LLM
 *   3. The model sees its prior context (including partial work) and continues
 *
 * Usage:
 *   /retry
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RETRY_TRIGGER = "retry-trigger";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("retry", {
		description: "Continue the last turn — invisible to the model",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			pi.sendMessage(
				{
					customType: RETRY_TRIGGER,
					content: "",
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});

	// Strip the retry trigger from LLM context — the model never sees it
	pi.on("context", async (event, _ctx) => {
		const filtered = event.messages.filter((m) => {
			if ("customType" in m) {
				return (m as { customType: string }).customType !== RETRY_TRIGGER;
			}
			return true;
		});
		return { messages: filtered };
	});
}
