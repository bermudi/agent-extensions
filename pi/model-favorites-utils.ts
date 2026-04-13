export interface ModelLike {
	provider: string;
	id: string;
	name?: string;
}

export interface PartitionedModels<T extends ModelLike> {
	favorites: T[];
	recent: T[];
	others: T[];
}

export const MAX_RECENT_MODELS = 8;

export function modelKey(model: Pick<ModelLike, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function toggleFavoriteKeys(favorites: readonly string[], key: string): string[] {
	return favorites.includes(key) ? favorites.filter((value) => value !== key) : [key, ...favorites];
}

export function recordRecentKeys(recent: readonly string[], key: string, maxRecent: number = MAX_RECENT_MODELS): string[] {
	const next = [key, ...recent.filter((value) => value !== key)];
	return next.slice(0, maxRecent);
}

export function orderModelsForSelector<T extends ModelLike>(
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

export function partitionOrderedModels<T extends ModelLike>(
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

export function countHiddenFavorites(models: readonly ModelLike[], favorites: readonly string[]): number {
	const visible = new Set(models.map((model) => modelKey(model)));
	return favorites.filter((key) => !visible.has(key)).length;
}
