/**
 * Inject the active model's identity into the system prompt.
 *
 * Pi's default prompt never names the model. Asked "what model are you?",
 * models confabulate from training data, and gateway-routed models (kilo,
 * relays) have no way to learn their own identity at all.
 *
 * Implemented as a single prompt guideline — one plain bullet inside the
 * existing <rules> section, no dedicated section tag, no extra prompt
 * structure, ~8 tokens. The handler runs before every agent run
 * (before_agent_start), replacing any earlier identity line so a
 * mid-session model switch updates it; pi's section diff then re-sends
 * only the rules section for that run.
 *
 * Known window (pi 0.99.x, fixed upstream in 1.4.0): extension-triggered
 * turns (sendMessage with triggerTurn) don't fire before_agent_start, so
 * a run started that way immediately after a model switch carries the
 * previous identity line until the next user prompt corrects it.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Prefix marking our guideline line, so re-runs replace instead of pile up. */
const GUIDELINE_PREFIX = "Current model ID: ";

/** The one guideline line naming the model. Pure function of the model. */
export function buildIdentityGuideline(model: Model<Api>): string {
  return `Current model ID: ${model.provider}/${model.id}`;
}

export default function modelIdentity(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    const guidelines = event.systemPromptOptions.promptGuidelines;
    // Replace any earlier identity line (ours or a stale one from a
    // previous model) rather than appending, so the line never duplicates.
    for (let i = guidelines.length - 1; i >= 0; i--) {
      if (guidelines[i].startsWith(GUIDELINE_PREFIX)) guidelines.splice(i, 1);
    }
    if (ctx.model) guidelines.push(buildIdentityGuideline(ctx.model));
  });
}
