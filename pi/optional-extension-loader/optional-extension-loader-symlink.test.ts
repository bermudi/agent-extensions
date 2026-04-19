import { describe, expect, afterAll, beforeAll, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readdirSync } from "node:fs";

// ─── Inline the discovery function to test it in isolation ──────────

const SUPPORTED_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);

function isExtensionFile(path: string): boolean {
  return SUPPORTED_EXTENSIONS.has(/\.[^.]+$/.exec(path)?.[0] ?? "");
}

type ExtensionUnit = {
  name: string;
  unitPath: string;
  entryFile: string;
};

function discoverExtensionUnits(dir: string): ExtensionUnit[] {
  if (!existsSync(dir)) return [];

  const units: ExtensionUnit[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    // Handle regular files and symlinks-to-files
    if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(fullPath)) {
      units.push({
        name: entry.name.replace(/\.[^.]+$/, ""),
        unitPath: fullPath,
        entryFile: fullPath,
      });
      continue;
    }

    // Handle regular directories and symlinks-to-directories
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      for (const candidate of ["index.ts", "index.js", "index.mts", "index.mjs", "index.cts", "index.cjs"]) {
        const child = join(fullPath, candidate);
        if (existsSync(child)) {
          units.push({
            name: entry.name,
            unitPath: fullPath,
            entryFile: child,
          });
          break;
        }
      }
    }
  }
  return units;
}

// ─── Test fixtures ──────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `pi-symlink-test-${process.pid}`);

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "target-dir"), { recursive: true });
  mkdirSync(join(TEST_DIR, "extensions"), { recursive: true });

  // Regular file
  writeFileSync(join(TEST_DIR, "target-dir", "regular.ts"), "export default () => {};", "utf8");

  // File to be symlinked
  writeFileSync(join(TEST_DIR, "target-dir", "linked-ext.ts"), "export default () => {};", "utf8");

  // Directory to be symlinked
  mkdirSync(join(TEST_DIR, "target-dir", "linked-pkg"), { recursive: true });
  writeFileSync(join(TEST_DIR, "target-dir", "linked-pkg", "index.ts"), "export default () => {};", "utf8");

  // Non-extension file (should be ignored)
  writeFileSync(join(TEST_DIR, "target-dir", "readme.md"), "# readme", "utf8");

  // Create symlinks in the extensions dir
  symlinkSync(
    join(TEST_DIR, "target-dir", "linked-ext.ts"),
    join(TEST_DIR, "extensions", "linked-ext.ts"),
  );
  symlinkSync(
    join(TEST_DIR, "target-dir", "linked-pkg"),
    join(TEST_DIR, "extensions", "linked-pkg"),
  );
  // Regular file too
  writeFileSync(join(TEST_DIR, "extensions", "regular.ts"), "export default () => {};", "utf8");
  // Non-extension symlink (should be ignored)
  symlinkSync(
    join(TEST_DIR, "target-dir", "readme.md"),
    join(TEST_DIR, "extensions", "readme.md"),
  );
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────

describe("discoverExtensionUnits with symlinks", () => {
  test("discovers symlinked .ts file", () => {
    const units = discoverExtensionUnits(join(TEST_DIR, "extensions"));
    const linked = units.find((u) => u.name === "linked-ext");
    expect(linked).toBeDefined();
    expect(linked!.entryFile).toBe(join(TEST_DIR, "extensions", "linked-ext.ts"));
  });

  test("discovers symlinked directory with index.ts", () => {
    const units = discoverExtensionUnits(join(TEST_DIR, "extensions"));
    const linked = units.find((u) => u.name === "linked-pkg");
    expect(linked).toBeDefined();
    expect(linked!.entryFile).toBe(join(TEST_DIR, "extensions", "linked-pkg", "index.ts"));
  });

  test("still discovers regular files", () => {
    const units = discoverExtensionUnits(join(TEST_DIR, "extensions"));
    const regular = units.find((u) => u.name === "regular");
    expect(regular).toBeDefined();
  });

  test("ignores non-extension symlinks", () => {
    const units = discoverExtensionUnits(join(TEST_DIR, "extensions"));
    const readme = units.find((u) => u.name === "readme");
    expect(readme).toBeUndefined();
  });

  test("symlinked entries have the symlink path as unitPath", () => {
    const units = discoverExtensionUnits(join(TEST_DIR, "extensions"));
    const linked = units.find((u) => u.name === "linked-ext");
    expect(linked!.unitPath).toBe(join(TEST_DIR, "extensions", "linked-ext.ts"));
    // The symlink itself lives in extensions/, not target-dir/
    expect(lstatSync(linked!.unitPath).isSymbolicLink()).toBe(true);
  });

  test("discovers all expected units", () => {
    const units = discoverExtensionUnits(join(TEST_DIR, "extensions"));
    const names = units.map((u) => u.name).sort();
    expect(names).toEqual(["linked-ext", "linked-pkg", "regular"]);
  });
});
