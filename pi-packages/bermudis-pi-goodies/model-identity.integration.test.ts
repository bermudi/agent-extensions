/**
 * Real-pi insurance for model-identity (unit tests use a fake event shape).
 * Runs the handler's guideline mutation through pi's own
 * normalizeBuildSystemPromptOptions / buildSystemPromptSections /
 * diffSystemPromptSections, so a future pi release changing guideline
 * rendering or diff semantics fails here while the unit suite stays
 * green.
 *
 * Imports pi's module by filesystem path: the package's "exports" map has
 * no subpath for dist/core/system-prompt, and test files never ship
 * ("files" excludes *.test.ts), so the dev-only path is contained here.
 */
import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  normalizeBuildSystemPromptOptions,
  buildSystemPromptSections,
  diffSystemPromptSections,
} from "./node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import modelIdentity from "./model-identity.ts";

type Handler = (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown;

function registerHandler(): Handler {
  let handler: Handler | undefined;
  const api = {
    on: (_event: string, h: Handler) => {
      handler = h;
    },
  } as unknown as ExtensionAPI;
  modelIdentity(api);
  if (!handler) throw new Error("model-identity registered no handler");
  return handler;
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

/** Real pi options, mutated by the real handler, the way agent-start does. */
function runHandlerThrough(
  handler: Handler,
  model: Model<Api> | undefined,
): ReturnType<typeof buildSystemPromptSections> {
  const options = normalizeBuildSystemPromptOptions({ cwd: "/project" });
  const event = {
    type: "before_agent_start",
    systemPrompt: "",
    systemPromptOptions: options,
  } as unknown as BeforeAgentStartEvent;
  handler(event, { model } as unknown as ExtensionContext);
  return buildSystemPromptSections(options);
}

describe("model-identity against pi's real system-prompt code", () => {
  test("pi renders the identity as a plain bullet inside <rules>, no new tag", () => {
    const handler = registerHandler();
    const sections = runHandlerThrough(
      handler,
      makeModel("kilo", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
    );
    expect(sections.rules).toContain(
      "- Current model ID: kilo/claude-sonnet-4-5",
    );
    expect(Object.keys(sections)).not.toContain("active_model");
  });

  test("a model switch diffs to the rules section only", () => {
    const handler = registerHandler();
    const before = runHandlerThrough(
      handler,
      makeModel("kilo", "claude-sonnet-4-5"),
    );
    const after = runHandlerThrough(handler, makeModel("zai", "glm-5.3"));

    const patch = diffSystemPromptSections(before, after);
    expect(Object.keys(patch ?? {})).toEqual(["rules"]);
    expect(patch?.rules).toContain("Current model ID: zai/glm-5.3");
    expect(patch?.rules).not.toContain("claude-sonnet-4-5");
  });

  test("no model leaves no identity line in pi's own render", () => {
    const handler = registerHandler();
    const sections = runHandlerThrough(handler, undefined);
    expect(sections.rules).not.toContain("Current model ID:");
  });
});
