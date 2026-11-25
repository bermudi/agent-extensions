/**
 * Inject the active model's identity into the system prompt.
 *
 * Pi's default prompt never names the model. Asked "what model are you?",
 * models confabulate from training data, and gateway-routed models (kilo,
 * relays) have no way to learn their own identity at all.
 *
 * Implemented as one custom prompt section — `<identity>Current model ID:
 * provider/id</identity>`, ~10 tokens. A section, not a guideline bullet:
 * guidelines render only inside pi's default <rules> section, and a
 * SYSTEM.md replaces that whole prompt with a custom preamble that has no
 * rules, so the bullet was silently dropped in every such session (#40).
 * `systemPromptOptions.sections` renders in both the custom and default
 * branches of buildSystemPromptSections and goes through the same section
 * diff, so pi never rewrites the head system message: between turns the
 * prompt is byte-identical, and a mid-session model switch costs one small
 * <identity> patch. Editing the head from context_with_system would flip
 * that — the whole conversation prefix would miss cache on every model
 * switch, and that hook runs on every LLM call.
 *
 * The handler runs before every agent run (before_agent_start), replacing
 * the section so a mid-session model switch updates it.
 *
 * Known window (#42): a /model switch while a tool call is still running
 * applies from the next run — pi's setModel does not re-emit
 * before_agent_start — so that run's continuation keeps the previous identity.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Section tag. pi requires /^[a-z][a-z0-9_-]*$/ and reserves "preamble". */
const SECTION = "identity";

/** The section body naming the model. Pure function of the model. */
export function buildIdentitySection(model: Model<Api>): string {
  return `Current model ID: ${model.provider}/${model.id}`;
}

export default function modelIdentity(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    const { sections } = event.systemPromptOptions;
    if (ctx.model) sections[SECTION] = buildIdentitySection(ctx.model);
    else delete sections[SECTION];
  });
}
