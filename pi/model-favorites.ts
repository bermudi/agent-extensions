import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { modelsAreEqual, type Api, type Model } from "@mariozechner/pi-ai";
import {
	CustomEditor,
	DynamicBorder,
	SettingsManager,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
	type Focusable,
	type TUI,
} from "@mariozechner/pi-tui";

// ── Utilities (inlined to avoid symlink resolution issues) ────────────────

interface ModelLike {
	provider: string;
	id: string;
	name?: string;
}

const MAX_RECENT_MODELS = 8;

function modelKey(model: Pick<ModelLike, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function toggleFavoriteKeys(favorites: readonly string[], key: string): string[] {
	return favorites.includes(key) ? favorites.filter((value) => value !== key) : [key, ...favorites];
}

function recordRecentKeys(recent: readonly string[], key: string, maxRecent: number = MAX_RECENT_MODELS): string[] {
	const next = [key, ...recent.filter((value) => value !== key)];
	return next.slice(0, maxRecent);
}

function orderModelsForSelector<T extends ModelLike>(
	models: readonly T[],
	favorites: readonly string[],
	recent: readonly string[],
	currentKey?: string,
): T[] {
	const byKey = new Map<string, T>();
	for (const model of models) {
		byKey.set(modelKey(model), model);
	}

	const ordered: T[] = [];
	const seen = new Set<string>();
	const favoriteSet = new Set(favorites);

	const pushKey = (key: string): void => {
		const model = byKey.get(key);
		if (!model || seen.has(key)) return;
		seen.add(key);
		ordered.push(model);
	};

	for (const key of favorites) pushKey(key);
	for (const key of recent) {
		if (!favoriteSet.has(key)) pushKey(key);
	}

	const remaining = models.filter((model) => !seen.has(modelKey(model)));
	remaining.sort((left, right) => {
		const leftKey = modelKey(left);
		const rightKey = modelKey(right);
		const leftIsCurrent = currentKey !== undefined && leftKey === currentKey;
		const rightIsCurrent = currentKey !== undefined && rightKey === currentKey;

		if (leftIsCurrent && !rightIsCurrent) return -1;
		if (!leftIsCurrent && rightIsCurrent) return 1;

		const providerCompare = left.provider.localeCompare(right.provider);
		if (providerCompare !== 0) return providerCompare;

		const idCompare = left.id.localeCompare(right.id);
		if (idCompare !== 0) return idCompare;

		return (left.name ?? left.id).localeCompare(right.name ?? right.id);
	});

	ordered.push(...remaining);
	return ordered;
}

interface PartitionedModels<T extends ModelLike> {
	favorites: T[];
	recent: T[];
	others: T[];
}

function partitionOrderedModels<T extends ModelLike>(
	models: readonly T[],
	favorites: readonly string[],
	recent: readonly string[],
): PartitionedModels<T> {
	const favoriteSet = new Set(favorites);
	const recentSet = new Set(recent);
	const sections: PartitionedModels<T> = { favorites: [], recent: [], others: [] };

	for (const model of models) {
		const key = modelKey(model);
		if (favoriteSet.has(key)) {
			sections.favorites.push(model);
			continue;
		}
		if (recentSet.has(key)) {
			sections.recent.push(model);
			continue;
		}
		sections.others.push(model);
	}

	return sections;
}

function countHiddenFavorites(models: readonly ModelLike[], favorites: readonly string[]): number {
	const visible = new Set(models.map((model) => modelKey(model)));
	return favorites.filter((key) => !visible.has(key)).length;
}

// ── Extension ─────────────────────────────────────────────────────────────

/**
 * Model Favorites
 *
 * Replaces the model-select keybinding with a custom overlay selector that adds:
 * - Favorite models (toggle with Ctrl+F inside the selector)
 * - Recent models
 * - A /model-favorites command for opening the selector explicitly
 * - A /model-favorite command for toggling the current model quickly
 *
 * Pi handles the built-in /model command before extension commands, so /model itself
 * stays stock. Ctrl+L becomes the favorite-aware selector.
 *
 * Favorites and recents are stored globally in ~/.pi/agent/model-favorites.json.
 */

interface FavoriteModelStore {
	version: 1;
	favorites: string[];
	recent: string[];
}

interface KeybindingsLike {
	matches(data: string, action: string): boolean;
}

interface DisplayItem {
	kind: "section" | "model";
	label: string;
	model?: Model<Api>;
	key?: string;
	isFavorite?: boolean;
	isRecent?: boolean;
}

const STORE_VERSION = 1;
const STORE_PATH = join(getAgentDir(), "model-favorites.json");
const OVERLAY_WIDTH = 76;
const MAX_VISIBLE_ROWS = 12;
function createDefaultStore(): FavoriteModelStore {
	return {
		version: STORE_VERSION,
		favorites: [],
		recent: [],
	};
}

function sanitizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

async function loadStore(): Promise<FavoriteModelStore> {
	try {
		const raw = await readFile(STORE_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<FavoriteModelStore> | null;
		return {
			version: STORE_VERSION,
			favorites: sanitizeStringArray(parsed?.favorites),
			recent: sanitizeStringArray(parsed?.recent),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return createDefaultStore();
		throw error;
	}
}

async function saveStore(store: FavoriteModelStore): Promise<void> {
	await mkdir(dirname(STORE_PATH), { recursive: true });
	const tempPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
	const content = `${JSON.stringify(store, null, 2)}\n`;
	await writeFile(tempPath, content, "utf8");
	await rename(tempPath, STORE_PATH);
}

function formatModelSearchText(model: Model<Api>): string {
	return `${model.id} ${model.provider} ${model.provider}/${model.id} ${model.name}`;
}

function sectionLabel(title: string, count: number): string {
	return `${title} (${count})`;
}

class FavoriteModelSelectorComponent extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly hintText = new Text("", 0, 0);
	private readonly detailText = new Text("", 0, 0);
	private readonly footerText = new Text("", 0, 0);
	private readonly emptyText = new Text("", 0, 0);

	private _focused = false;
	private displayItems: DisplayItem[] = [];
	private selectedIndex = -1;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsLike,
		private readonly models: Model<Api>[],
		private currentModel: Model<Api> | undefined,
		private store: FavoriteModelStore,
		private readonly onToggleFavorite: (model: Model<Api>) => FavoriteModelStore,
		private readonly onSelectModel: (model: Model<Api>) => void,
		private readonly onCancel: () => void,
		private readonly errorMessage?: string,
	) {
		super();

		this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("accent", this.theme.bold("Select model")), 0, 0));
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(this.emptyText);
		this.addChild(this.detailText);
		this.addChild(new Spacer(1));
		this.addChild(this.footerText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));

		this.searchInput.onSubmit = () => {
			const selected = this.getSelectedModel();
			if (selected) this.onSelectModel(selected.model);
		};

		this.rebuild(true);
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild(false);
	}


	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
			this.onCancel();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = this.getSelectedModel();
			if (selected) this.onSelectModel(selected.model);
			return;
		}

		if (matchesKey(data, Key.ctrl("f"))) {
			const selected = this.getSelectedModel();
			if (!selected) return;
			this.store = this.onToggleFavorite(selected.model);
			this.rebuild(false);
			this.tui.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-MAX_VISIBLE_ROWS);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveSelection(MAX_VISIBLE_ROWS);
			return;
		}

		this.searchInput.handleInput(data);
		this.rebuild(false);
		this.tui.requestRender();
	}

	private rebuild(resetSelection: boolean): void {
		const previousSelectionKey = resetSelection ? undefined : this.getSelectedModel()?.key;
		const currentKey = this.currentModel ? modelKey(this.currentModel) : undefined;
		const orderedModels = orderModelsForSelector(this.models, this.store.favorites, this.store.recent, currentKey);
		const query = this.searchInput.getValue().trim();
		const matchedModels = query
			? fuzzyFilter(orderedModels, query, (model: Model<Api>) => formatModelSearchText(model))
			: orderedModels;
		const sections = partitionOrderedModels(matchedModels, this.store.favorites, this.store.recent);
		const hiddenFavorites = countHiddenFavorites(this.models as ModelLike[], this.store.favorites);

		this.displayItems = [];
		if (sections.favorites.length > 0) {
			this.displayItems.push({ kind: "section", label: sectionLabel("Favorites", sections.favorites.length) });
			for (const model of sections.favorites) this.displayItems.push(this.toModelItem(model, true, false));
		}
		if (sections.recent.length > 0) {
			this.displayItems.push({ kind: "section", label: sectionLabel("Recent", sections.recent.length) });
			for (const model of sections.recent) this.displayItems.push(this.toModelItem(model, false, true));
		}
		if (sections.others.length > 0) {
			this.displayItems.push({ kind: "section", label: query ? sectionLabel("Matches", sections.others.length) : sectionLabel("All models", sections.others.length) });
			for (const model of sections.others) this.displayItems.push(this.toModelItem(model, false, false));
		}

		const selectableIndexes = this.getSelectableIndexes();
		if (selectableIndexes.length === 0) {
			this.selectedIndex = -1;
		} else if (previousSelectionKey) {
			const nextIndex = this.displayItems.findIndex((item) => item.kind === "model" && item.key === previousSelectionKey);
			this.selectedIndex = nextIndex >= 0 ? nextIndex : selectableIndexes[0]!;
		} else {
			const currentIndex = currentKey
				? this.displayItems.findIndex((item) => item.kind === "model" && item.key === currentKey)
				: -1;
			this.selectedIndex = currentIndex >= 0 ? currentIndex : selectableIndexes[0]!;
		}

		this.hintText.setText(this.buildHintText(hiddenFavorites));
		this.footerText.setText(this.buildFooterText());
		this.updateList();
	}

	private toModelItem(model: Model<Api>, isFavorite: boolean, isRecent: boolean): DisplayItem {
		return {
			kind: "model",
			label: model.id,
			model,
			key: modelKey(model),
			isFavorite,
			isRecent,
		};
	}

	private buildHintText(hiddenFavorites: number): string {
		if (this.errorMessage) return this.theme.fg("error", this.errorMessage);
		if (hiddenFavorites > 0) {
			const suffix = hiddenFavorites === 1 ? "favorite is" : "favorites are";
			return this.theme.fg("warning", `${hiddenFavorites} ${suffix} hidden because their providers are not configured. Use /login if needed.`);
		}
		return this.theme.fg("muted", "Only showing models with configured auth.");
	}

	private buildFooterText(): string {
		const selected = this.getSelectedModel();
		const favoriteLabel = selected?.isFavorite ? "ctrl+f unfavorite" : "ctrl+f favorite";
		return this.theme.fg("dim", `↑↓ navigate • enter select • ${favoriteLabel} • esc cancel`);
	}

	private updateList(): void {
		this.listContainer.clear();
		const visibleItems = this.getVisibleItems();

		for (const { item, isSelected } of visibleItems) {
			if (item.kind === "section") {
				this.listContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold(item.label)), 0, 0));
				continue;
			}

			const model = item.model!;
			const isCurrent = modelsAreEqual(this.currentModel, model);
			const prefix = isSelected ? this.theme.fg("accent", "→") : this.theme.fg("dim", " ");
			const favorite = item.isFavorite ? this.theme.fg("warning", "★") : this.theme.fg("dim", "·");
			const provider = this.theme.fg("muted", `[${model.provider}]`);
			const current = isCurrent ? ` ${this.theme.fg("success", "✓")}` : "";
			const name = model.name && model.name !== model.id ? ` ${this.theme.fg("dim", model.name)}` : "";
			const content = `${prefix} ${favorite} ${model.id} ${provider}${current}${name}`;
			this.listContainer.addChild(new Text(content, 0, 0));
		}

		if (this.displayItems.length > visibleItems.length) {
			const position = this.getSelectionPosition();
			const selectable = this.getSelectableIndexes().length;
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(this.theme.fg("dim", `Showing ${visibleItems.length}/${this.displayItems.length} rows • item ${position}/${Math.max(selectable, 1)}`), 0, 0));
		}

		const selected = this.getSelectedModel();
		if (!selected) {
			this.emptyText.setText(this.theme.fg("muted", this.displayItems.length === 0 ? "No matching models." : ""));
			this.detailText.setText("");
			return;
		}

		this.emptyText.setText("");
		const flags: string[] = [];
		if (selected.isFavorite) flags.push("favorite");
		if (selected.isRecent) flags.push("recent");
		if (modelsAreEqual(this.currentModel, selected.model)) flags.push("current");
		const flagText = flags.length > 0 ? ` • ${flags.join(" • ")}` : "";
		const modelName = selected.model.name && selected.model.name !== selected.model.id ? selected.model.name : selected.model.id;
		this.detailText.setText(this.theme.fg("muted", `${selected.model.provider}/${selected.model.id} • ${modelName}${flagText}`));
	}

	private getVisibleItems(): Array<{ item: DisplayItem; isSelected: boolean }> {
		if (this.displayItems.length <= MAX_VISIBLE_ROWS) {
			return this.displayItems.map((item, index) => ({ item, isSelected: index === this.selectedIndex }));
		}

		const start = this.getWindowStart();
		const end = Math.min(start + MAX_VISIBLE_ROWS, this.displayItems.length);
		return this.displayItems.slice(start, end).map((item, offset) => {
			const index = start + offset;
			return { item, isSelected: index === this.selectedIndex };
		});
	}

	private getWindowStart(): number {
		if (this.selectedIndex < 0) return 0;
		const start = Math.max(0, this.selectedIndex - Math.floor(MAX_VISIBLE_ROWS / 2));
		return Math.min(start, Math.max(0, this.displayItems.length - MAX_VISIBLE_ROWS));
	}

	private moveSelection(delta: number): void {
		const selectableIndexes = this.getSelectableIndexes();
		if (selectableIndexes.length === 0) return;

		const currentPos = Math.max(0, selectableIndexes.indexOf(this.selectedIndex));
		const nextPos = ((currentPos + delta) % selectableIndexes.length + selectableIndexes.length) % selectableIndexes.length;
		this.selectedIndex = selectableIndexes[nextPos]!;
		this.updateList();
		this.tui.requestRender();
	}

	private getSelectableIndexes(): number[] {
		const indexes: number[] = [];
		for (let i = 0; i < this.displayItems.length; i++) {
			if (this.displayItems[i]?.kind === "model") indexes.push(i);
		}
		return indexes;
	}

	private getSelectedModel(): DisplayItem | undefined {
		const selected = this.displayItems[this.selectedIndex];
		return selected?.kind === "model" ? selected : undefined;
	}

	private getSelectionPosition(): number {
		const selectableIndexes = this.getSelectableIndexes();
		const pos = selectableIndexes.indexOf(this.selectedIndex);
		return pos >= 0 ? pos + 1 : 0;
	}
}

class ModelFavoritesEditor extends CustomEditor {
	constructor(
		tui: Parameters<typeof CustomEditor>[0],
		theme: Parameters<typeof CustomEditor>[1],
		private readonly keybindings: Parameters<typeof CustomEditor>[2],
		private readonly onOpenSelector: () => void,
	) {
		super(tui, theme, keybindings);
	}

	override handleInput(data: string): void {
		if (this.keybindings.matches(data, "app.model.select")) {
			this.onOpenSelector();
			return;
		}
		super.handleInput(data);
	}
}

export default function modelFavoritesExtension(pi: ExtensionAPI) {
	let store: FavoriteModelStore = createDefaultStore();
	let settingsManager: SettingsManager | undefined;
	let writeQueue: Promise<void> = Promise.resolve();

	const updateFavoriteStatus = (ctx: ExtensionContext): void => {
		if (!ctx.model) {
			ctx.ui.setStatus("model-favorite", undefined);
			return;
		}
		const favorite = store.favorites.includes(modelKey(ctx.model));
		ctx.ui.setStatus("model-favorite", favorite ? ctx.ui.theme.fg("warning", "★ favorite") : undefined);
	};

	const persistStore = (nextStore: FavoriteModelStore, ctx?: ExtensionContext): Promise<void> => {
		store = nextStore;
		writeQueue = writeQueue.then(async () => {
			await saveStore(nextStore);
		}).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[model-favorites] Failed to save ${STORE_PATH}: ${message}`);
			ctx?.ui.notify(`Model favorites: failed to save store (${message})`, "error");
		});
		return writeQueue;
	};

	const toggleFavorite = (model: Model<Api>, ctx: ExtensionContext): FavoriteModelStore => {
		const key = modelKey(model);
		const nextStore: FavoriteModelStore = {
			...store,
			favorites: toggleFavoriteKeys(store.favorites, key),
		};
		void persistStore(nextStore, ctx);
		updateFavoriteStatus(ctx);
		return nextStore;
	};

	const ensureSettingsManager = (ctx: ExtensionContext): SettingsManager => {
		settingsManager ??= SettingsManager.create(ctx.cwd);
		return settingsManager;
	};

	const selectModel = async (model: Model<Api>, ctx: ExtensionContext): Promise<void> => {
		const success = await pi.setModel(model);
		if (!success) {
			ctx.ui.notify(`No configured auth for ${model.provider}/${model.id}`, "error");
			return;
		}

		ensureSettingsManager(ctx).setDefaultModelAndProvider(model.provider, model.id);

		const nextStore: FavoriteModelStore = {
			...store,
			recent: recordRecentKeys(store.recent, modelKey(model)),
		};
		await persistStore(nextStore, ctx);
		updateFavoriteStatus(ctx);
		ctx.ui.notify(`Switched to ${model.provider}/${model.id}`, "info");
	};

	const resolveModels = async (ctx: ExtensionContext): Promise<{ models: Model<Api>[]; error?: string }> => {
		ctx.modelRegistry.refresh();
		const configError = ctx.modelRegistry.getError();
		try {
			const models = (await ctx.modelRegistry.getAvailable()) as Model<Api>[];
			return { models, error: configError };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				models: [],
				error: configError ? `${configError}\n${message}` : message,
			};
		}
	};

	const openSelector = async (ctx: ExtensionContext): Promise<void> => {
		const { models, error } = await resolveModels(ctx);

		if (models.length === 0) {
			const message = error ?? "No models are available. Connect a provider with /login or configure an API key.";
			ctx.ui.notify(message, "warning");
			return;
		}

		let selectorStore = store;

		const selectedModel = await ctx.ui.custom<Model<Api> | null>(
			(tui, theme, keybindings, done) => new FavoriteModelSelectorComponent(
				tui,
				theme,
				keybindings as KeybindingsLike,
				models,
				ctx.model as Model<Api> | undefined,
				selectorStore,
				(model) => {
					selectorStore = toggleFavorite(model, ctx);
					return selectorStore;
				},
				(model) => done(model),
				() => done(null),
				error,
			),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: OVERLAY_WIDTH,
					minWidth: 60,
					maxHeight: "80%",
					margin: 1,
				},
			},
		);

		if (selectedModel) await selectModel(selectedModel, ctx);
	};

	pi.registerCommand("model-favorites", {
		description: "Open the favorite-aware model selector",
		handler: async (_args, ctx) => {
			await openSelector(ctx);
		},
	});

	pi.registerCommand("model-favorite", {
		description: "Toggle the current model as a favorite",
		handler: async (_args, ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("No active model to favorite", "warning");
				return;
			}
			const nextStore = toggleFavorite(ctx.model as Model<Api>, ctx);
			const favorite = nextStore.favorites.includes(modelKey(ctx.model));
			ctx.ui.notify(
				favorite ? `Favorited ${ctx.model.provider}/${ctx.model.id}` : `Unfavorited ${ctx.model.provider}/${ctx.model.id}`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		settingsManager = SettingsManager.create(ctx.cwd);
		if (ctx.hasUI) {
			ctx.ui.setEditorComponent(
				(tui, theme, keybindings) =>
					new ModelFavoritesEditor(tui, theme, keybindings, () => {
						void openSelector(ctx);
					}),
			);
		}
		try {
			store = await loadStore();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[model-favorites] Failed to load ${STORE_PATH}: ${message}`);
			store = createDefaultStore();
			ctx.ui.notify(`Model favorites: failed to load store (${message})`, "warning");
		}
		updateFavoriteStatus(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.source !== "restore") {
			const nextStore: FavoriteModelStore = {
				...store,
				recent: recordRecentKeys(store.recent, modelKey(event.model)),
			};
			await persistStore(nextStore, ctx);
		}
		updateFavoriteStatus(ctx);
	});
}
