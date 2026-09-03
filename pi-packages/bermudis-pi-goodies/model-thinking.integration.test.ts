/**
 * Real-Pi lifecycle insurance for model-thinking (unit tests use a fake
 * ExtensionAPI). The harness spins up a genuine AgentSession with the
 * extension factories loaded, so model switches, cycling, scoped pins,
 * and session events flow through Pi's own code paths. If a future Pi
 * release changes event ordering or switch semantics, these fail while
 * the unit suite stays green.
 *
 * Not covered here: /new's runtime replacement (the harness has no
 * runtime host). The /new composition is emulated by reverting the model
 * by hand and emitting the real session_before_switch/session_start
 * events through the real extension runner — keep-model-on-new's
 * setModel then fires the model_select that model-thinking listens to.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import keepModelOnNew from "./keep-model-on-new.ts";
import modelThinking, { writeStoredLevel } from "./model-thinking.ts";
import { setGoodiesLogPathForTesting } from "./goodies-log.ts";

interface ModelThinkingSession {
  test: TestSession;
  session: AgentSession;
  levelsPath: string;
}

interface ModelRuntimeForTest {
  getAvailableSnapshot(): readonly Model[];
}

const sessions: TestSession[] = [];
const scratchDirs: string[] = [];

afterEach(() => {
  while (sessions.length > 0) sessions.pop()?.dispose();
});

process.on("exit", () => {
  // Best effort; dispose also cleans the harness-owned temp cwd.
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function builtinModel(provider: string, id: string): Model {
  const model = getModel(provider, id);
  if (!model) throw new Error(`missing built-in test model ${provider}/${id}`);
  return model;
}

async function createModelThinkingSession(
  levels: Record<string, string> = {},
  cliArgs: string[] = [],
  withKeepModel = false,
): Promise<ModelThinkingSession> {
  const directory = mkdtempSync(join(tmpdir(), "model-thinking-integration-"));
  scratchDirs.push(directory);
  const levelsPath = join(directory, "thinking-levels.json");
  writeFileSync(levelsPath, `${JSON.stringify(levels)}\n`);
  setGoodiesLogPathForTesting(join(directory, "goodies.log"));

  const factories: ((pi: ExtensionAPI) => void)[] = [];
  if (withKeepModel) factories.push(keepModelOnNew);
  factories.push((pi) => modelThinking(pi, { levelsPath, cliArgs }));
  const test = await createTestSession({ extensionFactories: factories });
  sessions.push(test);
  // The harness patches ModelRuntime.checkAuth, but ExtensionAPI.setModel
  // gates on ModelRuntime.hasConfiguredAuth — patch that too for the
  // in-memory test session (no real API keys).
  const rt = (
    test.session as unknown as {
      _modelRuntime?: {
        hasConfiguredAuth?: (p: string) => boolean;
        checkAuth?: (p: string) => Promise<boolean>;
      };
    }
  )._modelRuntime;
  if (rt) {
    if (rt.hasConfiguredAuth) rt.hasConfiguredAuth = () => true;
    if (rt.checkAuth) rt.checkAuth = async () => true;
  }
  return { test, session: test.session as AgentSession, levelsPath };
}

/**
 * The harness deliberately starts with no authenticated catalog. Pi
 * filters Ctrl+P's scoped list against that catalog, so seed the test
 * models without replacing AgentSession's real cycle/event implementation.
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
  test("startup applies the sidecar level through the real session_start event", async () => {
    // The harness boots on openai/gpt-4o (reasoning:false, clamped to "off"),
    // so a startup test against that model cannot distinguish "applied low"
    // from "clamped to off". Test the same real event plumbing on a
    // reasoning model by emitting the event via the real extension runner.
    const gpt5 = builtinModel("openai", "gpt-5");
    const { session } = await createModelThinkingSession({
      "openai/gpt-5": "high",
    });
    await session.setModel(gpt5);
    session.setThinkingLevel("minimal");
    const runner = (
      session as unknown as {
        extensionRunner: {
          emit: (event: object) => Promise<unknown>;
        };
      }
    ).extensionRunner;
    await runner.emit({ type: "session_start", reason: "startup" });
    expect(session.thinkingLevel).toBe("high");
  });

  test("startup with --thinking leaves the explicit level in place", async () => {
    const gpt5 = builtinModel("openai", "gpt-5");
    const { session } = await createModelThinkingSession(
      { "openai/gpt-5": "high" },
      ["--thinking", "minimal"],
    );
    await session.setModel(gpt5);
    // The constructor's --thinking flag is baked into this session's
    // model-thinking closure; re-emitting startup here still suppresses
    // the sidecar, proving the CLI-args guard runs on the real event.
    session.setThinkingLevel("minimal");
    const runner = (
      session as unknown as {
        extensionRunner: { emit: (event: object) => Promise<unknown> };
      }
    ).extensionRunner;
    await runner.emit({ type: "session_start", reason: "startup" });
    expect(session.thinkingLevel).toBe("minimal");
  });

  test("applies a sidecar level after a real model selection", async () => {
    const gpt5 = builtinModel("openai", "gpt-5");
    const { session } = await createModelThinkingSession({
      "openai/gpt-5": "high",
    });

    await session.setModel(gpt5);

    expect(session.model).toMatchObject({ provider: "openai", id: "gpt-5" });
    expect(session.thinkingLevel).toBe("high");
  });

  test("applies a sidecar level on real Ctrl+P cycling", async () => {
    const gpt5 = builtinModel("openai", "gpt-5");
    const gpt5Mini = builtinModel("openai", "gpt-5-mini");
    const { session } = await createModelThinkingSession({
      "openai/gpt-5": "low",
      "openai/gpt-5-mini": "minimal",
    });
    await session.setModel(gpt5);
    makeModelsAvailable(session, [gpt5, gpt5Mini]);
    session.setScopedModels([{ model: gpt5 }, { model: gpt5Mini }]);

    await session.cycleModel();

    expect(session.model).toMatchObject({
      provider: "openai",
      id: "gpt-5-mini",
    });
    expect(session.thinkingLevel).toBe("minimal");
  });

  test("a native scoped level still outranks the sidecar while cycling", async () => {
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

  test("applies the scoped pin on full-picker selection, where Pi drops it", async () => {
    const gpt5 = builtinModel("openai", "gpt-5");
    const { session } = await createModelThinkingSession({
      "openai/gpt-5": "low",
    });
    makeModelsAvailable(session, [gpt5]);
    session.setScopedModels([{ model: gpt5, thinkingLevel: "high" }]);

    await session.setModel(gpt5);

    expect(session.thinkingLevel).toBe("high");
  });

  test("/new composition: keep-model-on-new's restore lands on the model's default", async () => {
    const gpt4o = builtinModel("openai", "gpt-4o");
    const gpt5 = builtinModel("openai", "gpt-5");
    const directory = mkdtempSync(
      join(tmpdir(), "model-thinking-integration-"),
    );
    scratchDirs.push(directory);
    const levelsPath = join(directory, "thinking-levels.json");
    writeFileSync(
      levelsPath,
      `${JSON.stringify({ "openai/gpt-5": "high" })}\n`,
    );
    setGoodiesLogPathForTesting(join(directory, "goodies.log"));
    // The global handoff map is process-wide; use an explicit shared Map
    // like keep-model-on-new's own unit tests to avoid cross-test flakiness.
    const sharedHandoffs = new Map<string, { provider: string; id: string }>();
    const testSession = await createTestSession({
      extensionFactories: [
        (pi) => keepModelOnNew(pi, { pendingModels: sharedHandoffs }),
        (pi) => modelThinking(pi, { levelsPath }),
      ],
    });
    sessions.push(testSession);
    const rt2 = (
      testSession.session as unknown as {
        _modelRuntime?: {
          hasConfiguredAuth?: (p: string) => boolean;
          checkAuth?: (p: string) => Promise<boolean>;
        };
      }
    )._modelRuntime;
    if (rt2) {
      if (rt2.hasConfiguredAuth) rt2.hasConfiguredAuth = () => true;
      if (rt2.checkAuth) rt2.checkAuth = async () => true;
    }
    const { session } = testSession as { session: AgentSession };
    await session.setModel(gpt5);
    expect(session.thinkingLevel).toBe("high");
    const runner = (
      session as unknown as {
        extensionRunner: {
          emit: (event: object) => Promise<unknown>;
        };
      }
    ).extensionRunner;
    // The active model before /new is gpt-5 — keep-model remembers it.
    await runner.emit({ type: "session_before_switch", reason: "new" });
    // Fresh runtime reverts to the default model. In a real /new this is
    // a new AgentSession; here we switch back under the same runner
    // whose handoff still holds gpt-5. gpt-4o is non-reasoning, so the level
    // clamps to "off" on this revert.
    await session.setModel(gpt4o);
    expect(session.thinkingLevel).toBe("off");
    await runner.emit({ type: "session_start", reason: "new" });

    expect(session.model).toMatchObject({ provider: "openai", id: "gpt-5" });
    expect(session.thinkingLevel).toBe("high");
  });

  test("the sidecar file is shared: an external save applies on the next switch", async () => {
    // gpt-5 supports minimal..high (xhigh/max map to null; saving those
    // would clamp to "high", so use a saveable level).
    const gpt5 = builtinModel("openai", "gpt-5");
    const { session, levelsPath } = await createModelThinkingSession({});

    // Another pi session (or a hand edit) writes the sidecar mid-flight;
    // levels are read fresh on every apply, so the next switch sees it.
    writeStoredLevel("openai/gpt-5", "minimal", levelsPath);
    expect(readFileSync(levelsPath, "utf8")).toContain("minimal");

    await session.setModel(gpt5);
    expect(session.thinkingLevel).toBe("minimal");
  });
});
