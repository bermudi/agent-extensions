// Pure model-list helpers, ported from pi-mono packages/coding-agent
// (src/modes/interactive/model-search.ts and the list logic of
// model-selector.ts). MIT, Copyright (c) 2025 Mario Zechner.
// Kept free of TUI imports so tests can exercise them directly.

import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import { fuzzyFilter } from "@earendil-works/pi-tui";

export interface ModelItem {
  provider: string;
  id: string;
  model: Model<any>;
}

export interface DefaultModelReference {
  provider: string;
  id: string;
}

export type ModelScope = "all" | "scoped";

/**
 * The /model selector search should rank exact provider-prefixed queries before proxy-provider IDs
 * like openrouter/openai/gpt-5, so keep the bare model ID out of the leading position.
 */
export function getModelSelectorSearchText(item: {
  id: string;
  provider: string;
  name?: string;
}): string {
  const { id, provider } = item;
  const name = item.name ? ` ${item.name}` : "";
  return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

const splitModelLabel = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Returns the model name when it has words the ID does not, e.g. a renamed override like
 * "MiniMax M3 [rasmus@openrouter, parasail]" for "minimax/minimax-m3". Names that only
 * restate the ID with different casing, separators, or a dropped namespace/version suffix
 * ("Claude Sonnet 4.5 (EU)" for "eu.anthropic.claude-sonnet-4-5-20250929-v1:0") return undefined.
 */
export function getDistinctModelName(item: {
  id: string;
  name?: string;
}): string | undefined {
  const name = item.name?.trim();
  if (!name) return undefined;
  const idWords = splitModelLabel(item.id);
  const idTokens = new Set(idWords);
  const compactId = idWords.join("");
  // Single-character words must match a whole ID token: "4" is not covered by "mistral-small-2603".
  const isCovered = (word: string): boolean =>
    idTokens.has(word) || (word.length > 1 && compactId.includes(word));
  return splitModelLabel(name).every(isCovered) ? undefined : name;
}

/** Typing a prefix of "default" pins the default model to the top of the list. */
export function isDefaultSearch(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return normalized.length > 0 && "default".startsWith(normalized);
}

export function isDefaultModel(
  model: Pick<ModelItem, "provider" | "id">,
  defaultModel?: DefaultModelReference,
): boolean {
  return (
    defaultModel?.provider === model.provider && defaultModel.id === model.id
  );
}

/**
 * Sort: current model first, default model second, then by provider.
 */
export function sortModels(
  models: ModelItem[],
  currentModel: Model<any> | undefined,
  defaultModel?: DefaultModelReference,
): ModelItem[] {
  const sorted = [...models];
  sorted.sort((a, b) => {
    const aIsCurrent = modelsAreEqual(currentModel, a.model);
    const bIsCurrent = modelsAreEqual(currentModel, b.model);
    if (aIsCurrent && !bIsCurrent) return -1;
    if (!aIsCurrent && bIsCurrent) return 1;
    const aIsDefault = isDefaultModel(a, defaultModel);
    const bIsDefault = isDefaultModel(b, defaultModel);
    if (aIsDefault && !bIsDefault) return -1;
    if (!aIsDefault && bIsDefault) return 1;
    return a.provider.localeCompare(b.provider);
  });
  return sorted;
}

/**
 * Fuzzy-filter over search text; a "default" query pins the default model to
 * the top (same behavior as the stock picker).
 */
export function filterModels(
  activeModels: ModelItem[],
  query: string,
  defaultModel?: DefaultModelReference,
): ModelItem[] {
  if (!query) return activeModels;
  const filtered = fuzzyFilter(activeModels, query, (item) => {
    const defaultText = isDefaultModel(item, defaultModel) ? " default" : "";
    return `${getModelSelectorSearchText({ id: item.id, provider: item.provider, name: item.model.name })}${defaultText}`;
  });
  if (isDefaultSearch(query)) {
    const defaultItems = activeModels.filter((item) =>
      isDefaultModel(item, defaultModel),
    );
    const defaultKeys = new Set(
      defaultItems.map((item) => `${item.provider}\0${item.id}`),
    );
    return [
      ...defaultItems,
      ...filtered.filter(
        (item) => !defaultKeys.has(`${item.provider}\0${item.id}`),
      ),
    ];
  }
  return filtered;
}

/** Index of `currentModel` in the list, or a clamped fallback. */
export function findSelectedIndex(
  items: ModelItem[],
  currentModel: Model<any> | undefined,
  fallback: number,
): number {
  const currentIndex = items.findIndex((item) =>
    modelsAreEqual(currentModel, item.model),
  );
  return currentIndex >= 0
    ? currentIndex
    : Math.min(fallback, Math.max(0, items.length - 1));
}
