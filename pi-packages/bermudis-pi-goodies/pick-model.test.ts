/**
 * pick-model — coverage for the with-UI picker path.
 *
 * The fallback paths (ctx.ui.select, the no-UI notice) were already
 * exercised indirectly; nothing drove the real TUI path — ctx.ui.custom →
 * ModelSelectorComponent → done(model) → the consumer's config/mode change
 * (issue #26). These tests fake only the host boundary: a ctx whose
 * ui.custom runs pi's actual component factory against a stub ModelRuntime
 * and feeds the component real key events, so the selector, its search
 * filtering, and the done() wiring are all shipped code. The consumer tests
 * then prove picker → done(model) → config set for /goodies summary-model,
 * /goodies recap-model, and /side.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { pickModel } from "./pick-model.ts";
import goodiesDefault, {
  __setConfigPathForTesting,
  getRecapModel,
  getSummaryModel,
} from "./goodies.ts";
import sideDefault from "./side.ts";
import { getSideSessionModel, resetSideBadgeState } from "./side-state.ts";
import { setGoodiesLogPathForTesting } from "./goodies-log.ts";

function makeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
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

/**
 * The private runtime field pick-model pokes out of the registry facade.
 * Only the members ModelSelectorComponent touches: the snapshot the list is
 * built from, scoped-model refresh lookups, the error line, and the
 * background catalog refresh (resolved instantly — no network).
 */
function fakeModelRuntime(catalog: Model<Api>[]) {
  return {
    getAvailableSnapshot: () => catalog,
    getModel: (provider: string, id: string) =>
      catalog.find((m) => m.provider === provider && m.id === id),
    getError: () => undefined,
    refresh: () =>
      Promise.resolve({ aborted: false, errors: new Map<string, Error>() }),
  };
}

/** arrow-down, then confirm — moves the highlight one row and selects it. */
const DOWN_ENTER = ["\x1b[B", "\r"];

interface PickerCtx {
  ctx: ExtensionCommandContext;
  notices: Array<{ msg: string; level: string }>;
  selects: Array<{ title: string; labels: string[] }>;
  statuses: Array<[string, string | undefined]>;
  customCalls: () => number;
}

/**
 * A TUI-mode command ctx whose ui.custom invokes the real component factory
 * and drives the returned component with `keys` (raw keyData, like pi's
 * terminal input). done() resolves the custom() promise exactly like the
 * host does. `customThrows` simulates custom() being unavailable so the
 * select fallback runs; `withRuntime: false` omits the private runtime
 * field so the selector never engages.
 */
function makePickerCtx(options: {
  catalog: Model<Api>[];
  keys?: string[];
  customThrows?: boolean;
  withRuntime?: boolean;
  selectAnswer?: string;
  branch?: readonly unknown[];
  leafId?: string;
}): PickerCtx {
  // ModelSelectorComponent renders through pi's global theme proxy, which
  // throws until initTheme runs.
  initTheme("dark");
  const notices: PickerCtx["notices"] = [];
  const selects: PickerCtx["selects"] = [];
  const statuses: PickerCtx["statuses"] = [];
  const keys = options.keys ?? DOWN_ENTER;
  const catalog = options.catalog;
  const branch = options.branch ?? [];
  const customCalls = { count: 0 };
  const registry = {
    find: (provider: string, id: string) =>
      catalog.find((m) => m.provider === provider && m.id === id),
    getAvailable: () => catalog,
    hasConfiguredAuth: () => true,
    ...(options.withRuntime === false
      ? {}
      : { runtime: fakeModelRuntime(catalog) }),
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    model: catalog[0],
    thinkingLevel: "high",
    scopedModels: [],
    modelRegistry: registry,
    waitForIdle: async () => {},
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
      getLeafId: () => options.leafId ?? "tip-1",
    },
    ui: {
      notify: (msg: string, level: string) => {
        notices.push({ msg, level });
      },
      select: async (title: string, labels: string[]) => {
        selects.push({ title, labels });
        return options.selectAnswer;
      },
      setStatus: (key: string, text: string | undefined) => {
        statuses.push([key, text]);
      },
      custom: <T>(
        factory: (
          tui: { requestRender(): void },
          theme: unknown,
          keybindings: unknown,
          done: (result: T) => void,
        ) => { handleInput(data: string): void },
      ): Promise<T> => {
        customCalls.count += 1;
        if (options.customThrows) {
          return Promise.reject(new Error("custom UI unavailable"));
        }
        return new Promise<T>((resolve) => {
          const component = factory(
            { requestRender() {} },
            {},
            {},
            (result: T) => resolve(result),
          );
          for (const key of keys) component.handleInput(key);
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    notices,
    selects,
    statuses,
    customCalls: () => customCalls.count,
  };
}

const CATALOG = [
  makeModel("kilo", "glm-5.3"),
  makeModel("zai", "glm-5.3-flash"),
];

const PICK_OPTIONS = {
  owner: "test",
  title: "Pick a model",
  noUiHint: "pass it as an argument",
};

describe("pickModel TUI selector path", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pick-model-test-"));
    setGoodiesLogPathForTesting(join(dir, "goodies.log"));
  });
  afterEach(() => {
    setGoodiesLogPathForTesting();
    resetSideBadgeState();
  });

  test("arrow keys + confirm resolve the highlighted model via done()", async () => {
    const h = makePickerCtx({ catalog: CATALOG });
    // ctx.model (catalog[0]) sorts first as the current model; down moves to
    // catalog[1] and enter confirms it.
    const picked = await pickModel(h.ctx, PICK_OPTIONS);
    expect(picked).toBe(CATALOG[1]);
    expect(h.selects).toHaveLength(0); // the TUI selector handled it
    expect(h.customCalls()).toBe(1);
  });

  test("typing a search filters the list before confirm", async () => {
    const h = makePickerCtx({
      catalog: CATALOG,
      // "flash" only fuzzy-matches zai/glm-5.3-flash; kilo/glm-5.3 has no f.
      keys: [..."flash", "\r"],
    });
    const picked = await pickModel(h.ctx, PICK_OPTIONS);
    expect(picked).toBe(CATALOG[1]);
    expect(h.selects).toHaveLength(0);
  });

  test("escape cancels through done(undefined)", async () => {
    const h = makePickerCtx({ catalog: CATALOG, keys: ["\x1b"] });
    const picked = await pickModel(h.ctx, PICK_OPTIONS);
    expect(picked).toBeUndefined();
    expect(h.selects).toHaveLength(0);
  });

  test("a throwing custom() falls back to ctx.ui.select and logs it", async () => {
    const h = makePickerCtx({
      catalog: CATALOG,
      customThrows: true,
      selectAnswer: "zai/glm-5.3-flash",
    });
    const picked = await pickModel(h.ctx, PICK_OPTIONS);
    expect(picked).toBe(CATALOG[1]);
    expect(h.selects).toEqual([
      { title: "Pick a model", labels: ["kilo/glm-5.3", "zai/glm-5.3-flash"] },
    ]);
    const log = readFileSync(join(dir, "goodies.log"), "utf-8");
    expect(log).toContain("test_picker_fallback");
  });

  test("a registry without the runtime field goes straight to ctx.ui.select", async () => {
    const h = makePickerCtx({
      catalog: CATALOG,
      withRuntime: false,
      selectAnswer: "kilo/glm-5.3",
    });
    const picked = await pickModel(h.ctx, PICK_OPTIONS);
    expect(picked).toBe(CATALOG[0]);
    expect(h.customCalls()).toBe(0);
    expect(h.selects).toHaveLength(1);
  });
});

describe("picker → done(model) → config set", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pick-model-cfg-"));
    __setConfigPathForTesting(join(dir, "goodies.json"));
    setGoodiesLogPathForTesting(join(dir, "goodies.log"));
    resetSideBadgeState();
  });
  afterEach(() => {
    setGoodiesLogPathForTesting();
    resetSideBadgeState();
  });

  function registerGoodies(): {
    handler: (args: string, ctx: never) => Promise<void>;
  } {
    let captured!: { handler: (args: string, ctx: never) => Promise<void> };
    goodiesDefault({
      on: () => {},
      registerCommand: (_name: string, opts: typeof captured) => {
        captured = opts;
      },
    } as never);
    return captured;
  }

  test("/goodies summary-model pick stores the selector's choice", async () => {
    const cmd = registerGoodies();
    const h = makePickerCtx({ catalog: CATALOG });
    await cmd.handler("summary-model pick", h.ctx as never);
    expect(getSummaryModel()).toBe("zai/glm-5.3-flash");
    expect(h.notices).toEqual([
      {
        msg: "Smart summaries will use zai/glm-5.3-flash",
        level: "info",
      },
    ]);
    expect(h.selects).toHaveLength(0);
  });

  test("/goodies recap-model pick stores the selector's choice", async () => {
    const cmd = registerGoodies();
    const h = makePickerCtx({ catalog: CATALOG });
    await cmd.handler("recap-model pick", h.ctx as never);
    expect(getRecapModel()).toBe("zai/glm-5.3-flash");
    expect(h.notices).toEqual([
      { msg: "Recaps will use zai/glm-5.3-flash", level: "info" },
    ]);
    expect(h.selects).toHaveLength(0);
  });

  test("/side with no args opens the side session on the selector's choice", async () => {
    const commands = new Map<
      string,
      { handler: (args: string, ctx: never) => Promise<void> }
    >();
    const setModelCalls: unknown[] = [];
    const appended: Array<[string, unknown]> = [];
    sideDefault({
      on: () => {},
      registerEntryRenderer: () => {},
      registerMessageRenderer: () => {},
      registerCommand: (
        name: string,
        opts: { handler: (args: string, ctx: never) => Promise<void> },
      ) => commands.set(name, opts),
      setModel: async (model: unknown) => {
        setModelCalls.push(model);
        return true;
      },
      setThinkingLevel: () => {},
      appendEntry: (type: string, data: unknown) => {
        appended.push([type, data]);
      },
    } as never);

    const h = makePickerCtx({
      catalog: CATALOG,
      branch: [{ type: "message", id: "m1" }],
      leafId: "tip-1",
    });
    await commands.get("side")!.handler("", h.ctx as never);

    // The picked model — not the parked main one — is what pi switched to.
    expect(setModelCalls).toHaveLength(1);
    expect(setModelCalls[0]).toBe(CATALOG[1]);
    expect(appended).toHaveLength(1);
    expect(appended[0]![0]).toBe("side-session");
    expect(appended[0]![1]).toMatchObject({
      sideModel: { provider: "zai", id: "glm-5.3-flash" },
      mainModel: { provider: "kilo", id: "glm-5.3" },
      mainTipId: "tip-1",
    });
    expect(getSideSessionModel()).toMatchObject({
      provider: "zai",
      id: "glm-5.3-flash",
    });
    expect(h.statuses).toContainEqual(["side", "side: zai/glm-5.3-flash"]);
    expect(h.notices.at(-1)?.msg).toContain("side session open");
    expect(h.selects).toHaveLength(0);
  });
});
