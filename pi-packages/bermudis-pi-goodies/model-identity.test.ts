import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import modelIdentity, { buildIdentityGuideline } from "./model-identity.ts";

type Handler = (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown;

class PiHarness {
  readonly handlers = new Map<string, Handler>();

  readonly api = {
    on: (event: string, handler: Handler) => {
      this.handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  async emit(event: string, payload: object, ctx: ExtensionContext) {
    const handler = this.handlers.get(event);
    expect(handler).toBeDefined();
    await handler(payload as BeforeAgentStartEvent, ctx);
  }
}

function makeModel(provider: string, id: string, name = id): Model<Api> {
  return {
    id,
    name,
    api: "openai-completions",
    provider,
    baseUrl: `https://${provider}.test/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    maxTokens: 100,
  };
}

/** Minimal before_agent_start event shape the module touches. */
function agentStartEvent(): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    systemPrompt: "",
    systemPromptOptions: {
      cwd: "/project",
      selectedTools: [],
      hiddenTools: [],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      sections: {},
      contextFiles: [],
      skills: [],
    },
  } as unknown as BeforeAgentStartEvent;
}

function contextWith(model: Model<Api> | undefined): ExtensionContext {
  return { model } as unknown as ExtensionContext;
}

describe("model-identity", () => {
  test("injects one guideline line naming the model", async () => {
    const pi = new PiHarness();
    modelIdentity(pi.api);
    const event = agentStartEvent();
    const model = makeModel("kilo", "claude-sonnet-4-5", "Claude Sonnet 4.5");

    await pi.emit("before_agent_start", event, contextWith(model));

    expect(event.systemPromptOptions.promptGuidelines).toEqual([
      "Current model ID: kilo/claude-sonnet-4-5",
    ]);
  });

  test("handler never inspects run provenance", async () => {
    // 0.99's event carries no trigger field and 1.4's adds messageType —
    // the handler must apply uniformly either way, so a bare event (the
    // least shape any pi version provides) still gets the line.
    const pi = new PiHarness();
    modelIdentity(pi.api);
    const event = agentStartEvent();
    const model = makeModel("openai", "gpt-5.4");

    await pi.emit("before_agent_start", event, contextWith(model));

    expect(event.systemPromptOptions.promptGuidelines).toEqual([
      buildIdentityGuideline(model),
    ]);
  });

  test("replaces a stale identity line instead of duplicating it", async () => {
    const pi = new PiHarness();
    modelIdentity(pi.api);
    const event = agentStartEvent();
    event.systemPromptOptions.promptGuidelines = [
      "Be concise",
      "Current model ID: kilo/claude-sonnet-4-5",
    ];

    await pi.emit(
      "before_agent_start",
      event,
      contextWith(makeModel("zai", "glm-5.3")),
    );

    expect(event.systemPromptOptions.promptGuidelines).toEqual([
      "Be concise",
      "Current model ID: zai/glm-5.3",
    ]);
  });

  test("removes the identity line when there is no active model", async () => {
    const pi = new PiHarness();
    modelIdentity(pi.api);
    const event = agentStartEvent();
    event.systemPromptOptions.promptGuidelines = [
      "Current model ID: kilo/claude-sonnet-4-5",
    ];

    await pi.emit("before_agent_start", event, contextWith(undefined));

    expect(event.systemPromptOptions.promptGuidelines).toEqual([]);
  });

  test("guideline text is a pure function of the model", () => {
    const model = makeModel("kilo", "qwen3-max", "Qwen3 Max");
    expect(buildIdentityGuideline(model)).toBe(buildIdentityGuideline(model));
    expect(buildIdentityGuideline(model)).toBe(
      "Current model ID: kilo/qwen3-max",
    );
    expect(buildIdentityGuideline(makeModel("zai", "glm-5.3"))).toBe(
      "Current model ID: zai/glm-5.3",
    );
  });
});
