import { describe, expect, it } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { ModelPickerComponent } from "./model-picker.ts";
import { type ModelItem, sortModels } from "./picker-models.ts";

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

function item(id: string, provider: string, name?: string): ModelItem {
  const m = model(id, provider, name);
  return { provider, id, model: m };
}

// Minimal stand-ins for the objects ctx.ui.custom hands the factory.
const fakeTui = { requestRender() {} } as unknown as TUI;
const fakeTheme = {
  fg: (_color: string, text: string) => text,
} as unknown as import("@earendil-works/pi-coding-agent").Theme;
// The component takes the pi-coding-agent KeybindingsManager (the richer
// manager pi's factory passes); pi-tui's getKeybindings() is the same
// matching logic without the config-file plumbing.
const kb = getKeybindings() as unknown as KeybindingsManager;

// Raw terminal bytes for the actions the component listens for. Sanity-checked
// against matchesKey so a pi-tui encoding change fails loudly here instead of
// silently passing.
const RAW: Record<string, string> = {
  confirm: "\r",
  cancel: "\x1b",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
};
for (const [name, data] of Object.entries(RAW)) {
  const action =
    name === "confirm"
      ? "tui.select.confirm"
      : name === "cancel"
        ? "tui.select.cancel"
        : name === "tab"
          ? "tui.input.tab"
          : `tui.select.${name}`;
  if (!kb.matches(data, action as never)) {
    throw new Error(
      `pi-tui key encoding changed: raw ${JSON.stringify(data)} no longer matches ${action}`,
    );
  }
}
const key = (name: keyof typeof RAW): string => RAW[name]!;

// Row prefix the component renders: cursor "→ " + two-space current marker.
const sel = (id: string): string => `→   ${id}`;

function fixtureItems(): ModelItem[] {
  return [
    item("claude-sonnet-4-5", "anthropic", "Claude Sonnet 4.5"),
    item("gpt-5", "openai"),
    item("kilo/glm-5.3", "kilo"),
    item("glm-5.3-flash", "zai", "GLM Flash"),
  ];
}

interface Harness {
  component: ModelPickerComponent;
  rendered: () => string;
  selected: Model<any>[];
  cancelled: boolean[];
}

function openPicker(opts: {
  scopedItems?: ModelItem[];
  currentModel?: Model<any>;
  defaultModel?: { provider: string; id: string };
  initialSearchInput?: string;
  maxVisible?: number;
}): Harness {
  const selected: Model<any>[] = [];
  const cancelled: boolean[] = [];
  const component = new ModelPickerComponent({
    tui: fakeTui,
    theme: fakeTheme,
    keybindings: kb,
    allItems: fixtureItems(),
    scopedItems: opts.scopedItems ?? [],
    currentModel: opts.currentModel,
    defaultModel: opts.defaultModel,
    initialSearchInput: opts.initialSearchInput,
    maxVisible: opts.maxVisible,
    onSelect: (m) => selected.push(m),
    onCancel: () => cancelled.push(true),
  });
  return {
    component,
    rendered: () => component.render(100).join("\n"),
    selected,
    cancelled,
  };
}

const DEFAULT_MODEL = { provider: "openai", id: "gpt-5" };

describe("ModelPickerComponent", () => {
  it("sorts current model first and marks it selected", () => {
    const current = fixtureItems()[3]!.model;
    const { rendered } = openPicker({ currentModel: current });
    const text = rendered();
    expect(text).toContain("✓ glm-5.3-flash");
    expect(text.indexOf("✓ glm-5.3-flash")).toBeLessThan(
      text.indexOf("claude-sonnet-4-5"),
    );
    expect(text).toContain("[anthropic]");
  });

  it("selects the highlighted model on confirm", () => {
    const current = fixtureItems()[1]!.model; // gpt-5 sorts first
    const { component, selected } = openPicker({ currentModel: current });
    component.handleInput(key("confirm"));
    expect(selected).toHaveLength(1);
    expect(selected[0]?.provider).toBe("openai");
    expect(selected[0]?.id).toBe("gpt-5");
  });

  it("cancels without selecting on escape", () => {
    const { component, selected, cancelled } = openPicker({});
    component.handleInput(key("cancel"));
    expect(cancelled).toHaveLength(1);
    expect(selected).toHaveLength(0);
  });

  it("wraps selection with up", () => {
    const { component, rendered, selected } = openPicker({});
    // No current model: provider sort puts anthropic first, zai last.
    component.handleInput(key("up"));
    expect(rendered()).toContain(sel("glm-5.3-flash"));
    component.handleInput(key("confirm"));
    expect(selected[0]?.id).toBe("glm-5.3-flash");
  });

  it("moves selection down and wraps to top", () => {
    const { component, rendered, selected } = openPicker({});
    // Provider sort: anthropic, kilo, openai, zai.
    component.handleInput(key("down"));
    expect(rendered()).toContain(sel("kilo/glm-5.3"));
    expect(rendered()).not.toContain(sel("claude-sonnet-4-5"));
    for (let i = 0; i < 3; i++) component.handleInput(key("down")); // wraps to first
    expect(rendered()).toContain(sel("claude-sonnet-4-5"));
    component.handleInput(key("confirm"));
    expect(selected[0]?.id).toBe("claude-sonnet-4-5");
  });

  it("filters as you type and confirm picks the top match", () => {
    const { component, rendered, selected } = openPicker({});
    for (const ch of "sonnet") component.handleInput(ch);
    const text = rendered();
    expect(text).toContain(sel("claude-sonnet-4-5"));
    expect(text).not.toContain("[openai]");
    expect(text).toContain("Model Name: Claude Sonnet 4.5");
    component.handleInput(key("confirm"));
    expect(selected[0]?.id).toBe("claude-sonnet-4-5");
  });

  it("shows the no-match placeholder when nothing matches", () => {
    const { component, rendered } = openPicker({});
    for (const ch of "zzzz") component.handleInput(ch);
    expect(rendered()).toContain("No matching models");
  });

  it("pins the default model for a 'default' query", () => {
    const { component, rendered, selected } = openPicker({
      defaultModel: DEFAULT_MODEL,
    });
    for (const ch of "default") component.handleInput(ch);
    const text = rendered();
    // Only the default item matches the "default" query; it is the sole row,
    // selected, and carries the badge.
    expect(text).toContain(sel("gpt-5"));
    expect(text).toContain("· default");
    expect(text).not.toContain("[anthropic]");
    component.handleInput(key("confirm"));
    expect(selected[0]?.id).toBe("gpt-5");
  });

  it("pre-fills the filter from the initial search input", () => {
    const { rendered } = openPicker({ initialSearchInput: "sonnet" });
    expect(rendered()).toContain(sel("claude-sonnet-4-5"));
    expect(rendered()).not.toContain("[openai]");
  });

  it("toggles scope with tab when scoped models exist", () => {
    const scoped = sortModels(fixtureItems(), undefined, undefined).slice(0, 2); // anthropic + kilo
    const { component, rendered } = openPicker({ scopedItems: scoped });
    expect(rendered()).toContain("Scope:");
    expect(rendered()).toContain(sel("claude-sonnet-4-5")); // scoped scope initially
    expect(rendered()).not.toContain("[zai]");
    component.handleInput(key("tab")); // switch to all
    expect(rendered()).toContain("[zai]");
    component.handleInput(key("tab")); // back to scoped
    expect(rendered()).not.toContain("[zai]");
  });

  it("ignores tab when no scoped models exist", () => {
    const { component, rendered } = openPicker({});
    expect(rendered()).not.toContain("Scope:");
    component.handleInput(key("tab"));
    expect(rendered()).not.toContain("Scope:");
  });

  it("respects maxVisible with a scroll indicator", () => {
    const many: ModelItem[] = Array.from({ length: 25 }, (_, i) =>
      item(`model-${String(i).padStart(2, "0")}`, "prov"),
    );
    const selected: Model<any>[] = [];
    const component = new ModelPickerComponent({
      tui: fakeTui,
      theme: fakeTheme,
      keybindings: kb,
      allItems: many,
      scopedItems: [],
      onSelect: (m) => selected.push(m),
      onCancel: () => {},
      maxVisible: 5,
    });
    const text = component.render(100).join("\n");
    expect(text).toContain("(1/25)");
    expect(text).toContain(sel("model-00"));
    expect(text).not.toContain("model-10");
  });
});
