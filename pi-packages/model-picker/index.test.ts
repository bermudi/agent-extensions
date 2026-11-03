import { describe, expect, it } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import modelPicker from "./index.ts";

function model(id: string, provider: string, name?: string): Model<any> {
  return {
    id,
    provider,
    name: name ?? id,
    api: "openai-completions",
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 4096,
  } as unknown as Model<any>;
}

const fakeTui = { requestRender() {} } as unknown as TUI;
const fakeTheme = {
  fg: (_color: string, text: string) => text,
} as unknown as import("@earendil-works/pi-coding-agent").Theme;

describe("extension wiring", () => {
  it("registers the ctrl+l shortcut and the /model-picker command", () => {
    const shortcuts: Array<{ key: string; description?: string }> = [];
    const commands: string[] = [];
    const pi = {
      registerShortcut: (key: string, opts: { description?: string }) =>
        shortcuts.push({ key, description: opts.description }),
      registerCommand: (name: string) => commands.push(name),
    } as unknown as ExtensionAPI;

    modelPicker(pi);

    expect(shortcuts.map((s) => s.key)).toEqual(["ctrl+l"]);
    expect(commands).toEqual(["model-picker"]);
  });

  it("renders from the registry snapshot and applies the selection via pi.setModel", async () => {
    const m1 = model("first", "prov-a");
    const m2 = model("second", "prov-b");
    const available = [m1, m2];

    const setModelCalls: Model<any>[] = [];
    const notifications: string[] = [];
    let shortcutHandler: ((ctx: ExtensionContext) => Promise<void>) | undefined;
    type CustomFactory = (
      tui: TUI,
      theme: unknown,
      keybindings: unknown,
      done: (result: Model<any> | undefined) => void,
    ) => unknown;
    let factory: CustomFactory | undefined;

    const pi = {
      getSettings: () => ({ defaultProvider: "prov-a", defaultModel: "first" }),
      setModel: async (m: Model<any>) => {
        setModelCalls.push(m);
        return true;
      },
      registerShortcut: (
        _key: string,
        opts: { handler: (ctx: ExtensionContext) => Promise<void> },
      ) => {
        shortcutHandler = opts.handler;
      },
      registerCommand: (_name: string, _opts: unknown) => {},
    } as unknown as ExtensionAPI;

    const ui = {
      // Mirror pi's showExtensionCustom contract: done(result) closes the
      // component AND resolves the custom() promise with the same value.
      custom: (f: CustomFactory) =>
        new Promise<Model<any> | undefined>((resolve) => {
          factory = (tui, theme, keybindings, done) =>
            f(tui, theme, keybindings, (result) => {
              done(result);
              resolve(result);
            });
        }),
      notify: (message: string) => notifications.push(message),
    };

    const ctx = {
      mode: "tui",
      hasUI: true,
      modelRegistry: { getAvailable: () => available },
      scopedModels: [{ model: m1 }],
      model: m1,
      ui,
    } as unknown as ExtensionContext;

    modelPicker(pi);
    expect(shortcutHandler).toBeDefined();

    const turn = shortcutHandler!(ctx);
    // Let ui.custom's promise microtasks settle, then drive the factory.
    await Promise.resolve();
    expect(factory).toBeDefined();

    const component = factory!(
      fakeTui,
      fakeTheme,
      getKeybindings(),
      () => {},
    ) as unknown as {
      render: (width: number) => string[];
      handleInput: (data: string) => void;
    };

    const text = component.render(100).join("\n");
    // One scoped model: the picker opens in scoped scope, ctx.model marked
    // current, settings default badged.
    expect(text).toContain("✓ first");
    expect(text).toContain("· default");
    expect(text).not.toContain("second");

    // Switch to all scope, select the second row: down, then enter.
    component.handleInput("\t");
    expect(component.render(100).join("\n")).toContain("second");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await turn;

    expect(setModelCalls).toHaveLength(1);
    expect(setModelCalls[0]?.id).toBe("second");
    expect(notifications).toEqual(["Model: second"]);
  });

  it("does nothing outside the TUI", async () => {
    let handlerCalls = 0;
    let shortcutHandler: ((ctx: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      getSettings: () => ({}),
      setModel: async () => {
        handlerCalls = -1000;
        return true;
      },
      registerShortcut: (
        _key: string,
        opts: { handler: (ctx: ExtensionContext) => Promise<void> },
      ) => {
        shortcutHandler = opts.handler;
      },
      registerCommand: (_name: string, _opts: unknown) => {},
    } as unknown as ExtensionAPI;
    const ui = {
      custom: async () => {
        handlerCalls += 1;
        return undefined;
      },
      notify: () => {},
    };
    const ctx = {
      mode: "rpc",
      hasUI: true,
      ui,
      modelRegistry: { getAvailable: () => [] },
      scopedModels: [],
      model: undefined,
    } as unknown as ExtensionContext;

    modelPicker(pi);
    await shortcutHandler!(ctx);
    expect(handlerCalls).toBe(0);
  });
});
