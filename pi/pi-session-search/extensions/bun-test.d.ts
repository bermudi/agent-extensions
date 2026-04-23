declare module "bun:test" {
	export function describe(name: string, fn: () => void): void;
	export function test(name: string, fn: () => void | Promise<void>): void;
	export const expect: {
		<T>(value: T): {
			toBe(expected: T): void;
			toEqual(expected: unknown): void;
			toBeNull(): void;
			toBeGreaterThan(expected: number): void;
			toBeLessThan(expected: number): void;
			toContain(expected: string): void;
			toHaveLength(expected: number): void;
			not: {
				toBeNull(): void;
				toContain(expected: string): void;
			};
		};
	};
}
