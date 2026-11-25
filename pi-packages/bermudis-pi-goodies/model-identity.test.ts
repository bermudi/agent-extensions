import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import modelIdentity, { buildIdentitySection } from "./model-identity.ts";

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
  test("sets the identity section naming the model", async () => {
    const pi = new PiHarness();
    modelIdentity(pi.api);
    const event = agentStartEvent();
    const model = makeModel("kilo", "claude-sonnet-4-5", "Claude Sonnet 4.5");

    await pi.emit("before_agent_start", event, contextWith(model));

    expect(event.systemPromptOptions.sections.identity).toBe(
      "Current model ID: kilo/claude-sonnet-4-5",
    );
    // The rules section is where a SYSTEM.md session loses it (#40).
    expect(event.systemPromptOptions.promptGuidelines).toEqual([]);
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

    expect(event.systemPromptOptions.sections.identity).toBe(
      buildIdentitySection(model),
    );
  });

  test("replaces a stale identity section without touching its neighbours", async () => {
    const pi = new PiHarness();
    modelIdentity(pi.api);
    const event = agentStartEvent();
    event.systemPromptOptions.sections = {
      identity: "Current model ID: kilo/claude-sonnet-4-5",
      other: "keep me",
    };

    await pi.emit(
      "before_agent_start",
      event,
      contextWith(makeModel("zai", "glm-5.3")),
    );

    expect(event.systemPromptOptions.sections).toEqual({
      identity: "Current model ID: zai/glm-5.3",
      other: "keep me",
    });
  });

  test("removes the identity section when there is no active model", async () => {
    const pi = new PiHarness();
    modelIdentity(pi.api);
    const event = agentStartEvent();
    event.systemPromptOptions.sections.identity =
      "Current model ID: kilo/claude-sonnet-4-5";

    await pi.emit("before_agent_start", event, contextWith(undefined));

    expect(event.systemPromptOptions.sections).toEqual({});
  });

  test("section text is a pure function of the model", () => {
    const model = makeModel("kilo", "qwen3-max", "Qwen3 Max");
    expect(buildIdentitySection(model)).toBe(buildIdentitySection(model));
    expect(buildIdentitySection(model)).toBe(
      "Current model ID: kilo/qwen3-max",
    );
    expect(buildIdentitySection(makeModel("zai", "glm-5.3"))).toBe(
      "Current model ID: zai/glm-5.3",
    );
  });
});
