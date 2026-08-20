import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type {
  AgentSession,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createTestSession,
  type TestSession,
} from "@marcfargas/pi-test-harness";
import modelThinking from "./model-thinking.ts";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface ModelThinkingSession {
  test: TestSession;
  session: AgentSession;
  levelsPath: string;
  inheritedLevelPath: string;
}

interface ModelRuntimeForTest {
  getAvailableSnapshot(): readonly Model[];
}

const sessions: TestSession[] = [];

afterEach(() => {
  while (sessions.length > 0) sessions.pop()?.dispose();
});

function builtinModel(provider: string, id: string): Model {
  const model = getModel(provider, id);
  if (!model) throw new Error(`missing built-in test model ${provider}/${id}`);
  return model;
}

async function createModelThinkingSession(
  levels: Record<string, ThinkingLevel> = {},
  inheritedLevel: ThinkingLevel = "low",
  beforeModelThinking?: (pi: ExtensionAPI) => void,
): Promise<ModelThinkingSession> {
  const directory = mkdtempSync(join(tmpdir(), "model-thinking-integration-"));
  const levelsPath = join(directory, "thinking-levels.json");
  const inheritedLevelPath = join(directory, "thinking-default.json");
  writeFileSync(levelsPath, `${JSON.stringify(levels)}\n`);
  writeFileSync(inheritedLevelPath, `${JSON.stringify(inheritedLevel)}\n`);

  const test = await createTestSession({
    extensionFactories: [
      ...(beforeModelThinking ? [beforeModelThinking] : []),
      (pi) => modelThinking(pi, { levelsPath, inheritedLevelPath }),
    ],
  });
  sessions.push(test);
  return {
    test,
    session: test.session as AgentSession,
    levelsPath,
    inheritedLevelPath,
  };
}

function waitForDeferredEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * The harness deliberately starts with no authenticated catalog. Pi filters
 * Ctrl+P's scoped list against that catalog, so seed the two test models
 * without replacing AgentSession's real cycle/event implementation.
 */
function makeModelsAvailable(
  session: AgentSession,
  models: readonly Model[],
): void {
  const runtime = (session as unknown as { _modelRuntime: ModelRuntimeForTest })
    ._modelRuntime;
  runtime.getAvailableSnapshot = () => models;
}

describe("model-thinking real Pi lifecycle", () => {
  test("applies a sidecar level after real model selection", async () => {
    const gpt5 = builtinModel("openai", "gpt-5");
    const { session } = await createModelThinkingSession({
      "openai/gpt-5": "high",
    });

    await session.setModel(gpt5);

    expect(session.model).toMatchObject({ provider: "openai", id: "gpt-5" });
    expect(session.thinkingLevel).toBe("high");
  });

  test("keeps a native scoped level when real Ctrl+P cycling applies it", async () => {
    const gpt5 = builtinModel("openai", "gpt-5");
    const gpt5Mini = builtinModel("openai", "gpt-5-mini");
    const { session } = await createModelThinkingSession({
      "openai/gpt-5": "low",
      "openai/gpt-5-mini": "minimal",
    });
    await session.setModel(gpt5);
    makeModelsAvailable(session, [gpt5, gpt5Mini]);
    session.setScopedModels([
      { model: gpt5 },
      { model: gpt5Mini, thinkingLevel: "high" },
    ]);

    await session.cycleModel();

    expect(session.model).toMatchObject({
      provider: "openai",
      id: "gpt-5-mini",
    });
    expect(session.thinkingLevel).toBe("high");
  });

  test("does not save Pi's normal model-switch re-clamp as the global default", async () => {
    const gpt5 = builtinModel("openai", "gpt-5");
    const gpt5Mini = builtinModel("openai", "gpt-5-mini");
    const { inheritedLevelPath, session } = await createModelThinkingSession();
    await session.setModel(gpt5);
    makeModelsAvailable(session, [gpt5, gpt5Mini]);
    session.setScopedModels([
      { model: gpt5 },
      { model: gpt5Mini, thinkingLevel: "high" },
    ]);

    await session.cycleModel();
    await waitForDeferredEvents();

    expect(JSON.parse(readFileSync(inheritedLevelPath, "utf8"))).toBe("low");
  });

  test("does not save a re-clamp while an earlier model hook is delayed", async () => {
    const gpt5 = builtinModel("openai", "gpt-5");
    const { inheritedLevelPath, session } = await createModelThinkingSession(
      {},
      "low",
      (pi) => {
        pi.on("model_select", async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
        });
      },
    );

    await session.setModel(gpt5);
    await waitForDeferredEvents();

    expect(JSON.parse(readFileSync(inheritedLevelPath, "utf8"))).toBe("low");
  });
});
