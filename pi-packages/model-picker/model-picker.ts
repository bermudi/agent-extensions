// Adapted from pi-mono packages/coding-agent
// src/modes/interactive/components/model-selector.ts (and its companions
// dynamic-border.ts, keybinding-hints.ts). MIT, Copyright (c) 2025 Mario
// Zechner. The one behavioral difference: NO catalog refresh on open. The
// stock constructor kicks `refreshModelCatalogs()` (network, 15s timeout)
// every time the picker opens; this component renders purely from the
// snapshot the session already holds (`ctx.modelRegistry.getAvailable()`),
// so opening it is instant and offline-safe.

import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
  type Component,
  Container,
  type Focusable,
  Input,
  type Keybinding,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type DefaultModelReference,
  filterModels as filterModelItems,
  findSelectedIndex,
  getDistinctModelName,
  isDefaultModel,
  type ModelItem,
  type ModelScope,
  sortModels,
} from "./picker-models.ts";

// --- dynamic-border.ts port (extension-safe: explicit color function) ---

class DynamicBorder implements Component {
  constructor(private color: (str: string) => string) {}
  invalidate(): void {}
  render(width: number): string[] {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}

// --- keybinding-hints.ts port, keyed off an injected manager ---

function formatKeyText(key: string, capitalize = false): string {
  return key
    .split("/")
    .map((k) =>
      k
        .split("+")
        .map((part) => {
          const displayPart =
            process.platform === "darwin" && part.toLowerCase() === "alt"
              ? "option"
              : part;
          return capitalize
            ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1)
            : displayPart;
        })
        .join("+"),
    )
    .join("/");
}

function keyDisplayText(
  kb: KeybindingsManager,
  keybinding: Keybinding,
): string {
  return formatKeyText(kb.getKeys(keybinding).join("/"), true);
}

function keyHint(
  kb: KeybindingsManager,
  theme: Theme,
  keybinding: Keybinding,
  description: string,
): string {
  return (
    theme.fg("dim", formatKeyText(kb.getKeys(keybinding).join("/"))) +
    theme.fg("muted", ` ${description}`)
  );
}

export interface ModelPickerOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  allItems: ModelItem[];
  scopedItems: ModelItem[];
  currentModel?: Model<any>;
  defaultModel?: DefaultModelReference;
  initialSearchInput?: string;
  maxVisible?: number;
  onSelect: (model: Model<any>) => void;
  onCancel: () => void;
}

/**
 * Component that renders a model selector with search — stock UI, snapshot data.
 */
export class ModelPickerComponent extends Container implements Focusable {
  private searchInput: Input;

  // Focusable implementation - propagate to searchInput for IME cursor positioning
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }
  private listContainer: Container;
  private allItems: ModelItem[];
  private scopedItems: ModelItem[];
  private activeItems: ModelItem[] = [];
  private filteredItems: ModelItem[] = [];
  private selectedIndex = 0;
  private currentModel?: Model<any>;
  private readonly onSelectCallback: (model: Model<any>) => void;
  private readonly onCancelCallback: () => void;
  private readonly theme: Theme;
  private readonly kb: KeybindingsManager;
  private readonly defaultModel?: DefaultModelReference;
  private scope: ModelScope;
  private scopeText?: Text;
  private scopeHintText?: Text;
  private readonly maxVisible: number;
  private closed = false;

  constructor(options: ModelPickerOptions) {
    super();
    this.theme = options.theme;
    this.kb = options.keybindings;
    this.currentModel = options.currentModel;
    this.defaultModel = options.defaultModel;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.maxVisible = options.maxVisible ?? 10;
    this.scopedItems = options.scopedItems;
    this.scope = this.scopedItems.length > 0 ? "scoped" : "all";

    this.allItems = sortModels(
      options.allItems,
      this.currentModel,
      this.defaultModel,
    );
    this.activeItems =
      this.scope === "scoped" ? this.scopedItems : this.allItems;
    this.filteredItems = this.activeItems;
    this.selectedIndex = findSelectedIndex(
      this.filteredItems,
      this.currentModel,
      0,
    );

    // Add top border
    this.addChild(new DynamicBorder((str) => this.theme.fg("border", str)));
    this.addChild(new Spacer(1));

    // Add hint about model filtering
    if (this.scopedItems.length > 0) {
      this.scopeText = new Text(this.getScopeText(), 0, 0);
      this.addChild(this.scopeText);
      this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
      this.addChild(this.scopeHintText);
    } else {
      const hintText =
        "Only showing models from configured providers. Use /login to add providers.";
      this.addChild(new Text(this.theme.fg("warning", hintText), 0, 0));
    }
    this.addChild(new Spacer(1));

    // Create search input
    this.searchInput = new Input();
    if (options.initialSearchInput) {
      this.searchInput.setValue(options.initialSearchInput);
    }
    this.searchInput.onSubmit = () => {
      // Enter on search input selects the first filtered item
      if (this.filteredItems[this.selectedIndex]) {
        this.handleSelect(this.filteredItems[this.selectedIndex].model);
      }
    };
    this.addChild(this.searchInput);

    this.addChild(new Spacer(1));

    // Create list container
    this.listContainer = new Container();
    this.addChild(this.listContainer);

    this.addChild(new Spacer(1));

    // Hint
    const hints = [
      keyDisplayText(this.kb, "tui.select.confirm") + " to select",
    ];
    if (this.scopedItems.length > 0) {
      hints.push(keyDisplayText(this.kb, "tui.input.tab") + " scope");
    }
    hints.push(keyDisplayText(this.kb, "tui.select.cancel") + " to cancel");
    this.addChild(
      new Text(this.theme.fg("dim", `  ${hints.join(" · ")}`), 0, 0),
    );

    // Add bottom border
    this.addChild(new DynamicBorder((str) => this.theme.fg("border", str)));

    if (options.initialSearchInput)
      this.filterItems(options.initialSearchInput);
    else this.updateList();
    options.tui.requestRender();
  }

  private getScopeText(): string {
    const allText =
      this.scope === "all"
        ? this.theme.fg("accent", "all")
        : this.theme.fg("muted", "all");
    const scopedText =
      this.scope === "scoped"
        ? this.theme.fg("accent", "scoped")
        : this.theme.fg("muted", "scoped");
    return `${this.theme.fg("muted", "Scope: ")}${allText}${this.theme.fg("muted", " | ")}${scopedText}`;
  }

  private getScopeHintText(): string {
    return (
      keyHint(this.kb, this.theme, "tui.input.tab", "scope") +
      this.theme.fg("muted", " (all/scoped)")
    );
  }

  private setScope(scope: ModelScope): void {
    if (this.scope === scope) return;
    this.scope = scope;
    this.activeItems =
      this.scope === "scoped" ? this.scopedItems : this.allItems;
    this.selectedIndex = findSelectedIndex(
      this.activeItems,
      this.currentModel,
      0,
    );
    this.filterItems(this.searchInput.getValue());
    if (this.scopeText) {
      this.scopeText.setText(this.getScopeText());
    }
  }

  private filterItems(query: string): void {
    this.filteredItems = filterModelItems(
      this.activeItems,
      query,
      this.defaultModel,
    );
    // When filtering by a query, move the selector to the top row so the best
    // match is highlighted. When the query is cleared, keep the current position
    // clamped to the (restored) list length.
    this.selectedIndex = query
      ? 0
      : Math.min(
          this.selectedIndex,
          Math.max(0, this.filteredItems.length - 1),
        );
    this.updateList();
  }

  private updateList(): void {
    this.listContainer.clear();

    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.filteredItems.length - this.maxVisible,
      ),
    );
    const endIndex = Math.min(
      startIndex + this.maxVisible,
      this.filteredItems.length,
    );

    // Show visible slice of filtered models
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i];
      if (!item) continue;

      const isSelected = i === this.selectedIndex;
      const isCurrent = modelsAreEqual(this.currentModel, item.model);
      const isDefault = isDefaultModel(item, this.defaultModel);
      const defaultBadge = isDefault
        ? this.theme.fg("muted", " · default")
        : "";

      const cursor = isSelected ? this.theme.fg("accent", "→ ") : "  ";
      const currentMarker = isCurrent ? this.theme.fg("accent", "✓ ") : "  ";
      const modelText = isSelected ? this.theme.fg("accent", item.id) : item.id;
      const name = getDistinctModelName({ id: item.id, name: item.model.name });
      const nameText = name ? this.theme.fg("muted", ` (${name})`) : "";
      const providerBadge = this.theme.fg("muted", `[${item.provider}]`);
      const line = `${cursor}${currentMarker}${modelText}${nameText} ${providerBadge}${defaultBadge}`;

      this.listContainer.addChild(new Text(line, 0, 0));
    }

    // Add scroll indicator if needed
    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      const scrollInfo = this.theme.fg(
        "muted",
        `  (${this.selectedIndex + 1}/${this.filteredItems.length})`,
      );
      this.listContainer.addChild(new Text(scrollInfo, 0, 0));
    }

    if (this.filteredItems.length === 0) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", "  No matching models"), 0, 0),
      );
    } else {
      const selected = this.filteredItems[this.selectedIndex];
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(
        new Text(
          this.theme.fg("muted", `  Model Name: ${selected.model.name}`),
          0,
          0,
        ),
      );
    }
  }

  handleInput(keyData: string): void {
    if (this.kb.matches(keyData, "tui.input.tab")) {
      if (this.scopedItems.length > 0) {
        const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
        this.setScope(nextScope);
        if (this.scopeHintText) {
          this.scopeHintText.setText(this.getScopeHintText());
        }
      }
      return;
    }
    // Up arrow - wrap to bottom when at top
    if (this.kb.matches(keyData, "tui.select.up")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.filteredItems.length - 1
          : this.selectedIndex - 1;
      this.updateList();
    }
    // Down arrow - wrap to top when at bottom
    else if (this.kb.matches(keyData, "tui.select.down")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filteredItems.length - 1
          ? 0
          : this.selectedIndex + 1;
      this.updateList();
    }
    // Enter
    else if (this.kb.matches(keyData, "tui.select.confirm")) {
      const selectedModel = this.filteredItems[this.selectedIndex];
      if (selectedModel) {
        this.handleSelect(selectedModel.model);
      }
    }
    // Escape or Ctrl+C
    else if (this.kb.matches(keyData, "tui.select.cancel")) {
      this.dispose();
      this.onCancelCallback();
    }
    // Pass everything else to search input
    else {
      this.searchInput.handleInput(keyData);
      this.filterItems(this.searchInput.getValue());
    }
  }

  private handleSelect(model: Model<any>): void {
    this.dispose();
    this.onSelectCallback(model);
  }

  dispose(): void {
    // No background work to tear down (that's the point of this picker);
    // kept for the ui.custom dispose contract.
    this.closed = true;
  }
}
