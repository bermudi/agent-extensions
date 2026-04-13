import { describe, expect, test } from "bun:test";
import {
  expandHome,
  resolveMaybeRelative,
  isExtensionFile,
  unique,
  parseNpmPackageName,
  packageSettingSource,
  isOptionalPackageSetting,
  isManagedPackageSetting,
  isPackageLikeSource,
  removeStringFromArray,
  addUniqueString,
  findPackageIndex,
  normalizeRequestedName,
  findEntryByName,
  findPersistentItemByName,
  formatPersistentLines,
  completeNames,
  entryNameFromPath,
  deriveNameFromSource,
  sourceLabelForPath,
  OPTIONAL_DIR_NAME,
  OPTIONAL_CONFIG_NAME,
  SELF_NAME,
} from "./optional-extension-loader-utils.js";
import type { OptionalEntry, PersistentItem } from "./optional-extension-loader-utils.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ─── Path & Naming ──────────────────────────────────────────────────

describe("expandHome", () => {
  test("expands ~ to homedir", () => {
    expect(expandHome("~")).toBe(homedir());
  });

  test("expands ~/path", () => {
    expect(expandHome("~/foo/bar")).toBe(join(homedir(), "foo/bar"));
  });

  test("passes through absolute paths", () => {
    expect(expandHome("/tmp/x")).toBe("/tmp/x");
  });

  test("passes through relative paths", () => {
    expect(expandHome("relative/path")).toBe("relative/path");
  });
});

describe("resolveMaybeRelative", () => {
  test("resolves relative to base dir", () => {
    expect(resolveMaybeRelative("/base", "child.ts")).toBe(resolve("/base", "child.ts"));
  });

  test("passes through absolute paths", () => {
    expect(resolveMaybeRelative("/base", "/abs/path")).toBe("/abs/path");
  });

  test("expands ~/ before resolving", () => {
    expect(resolveMaybeRelative("/base", "~/foo")).toBe(join(homedir(), "foo"));
  });
});

describe("entryNameFromPath", () => {
  test("strips extension", () => {
    expect(entryNameFromPath("/foo/bar/my-ext.ts")).toBe("my-ext");
  });

  test("uses directory name for index files", () => {
    expect(entryNameFromPath("/foo/my-ext/index.ts")).toBe("my-ext");
  });

  test("handles .mjs extension", () => {
    expect(entryNameFromPath("/foo/bar.mjs")).toBe("bar");
  });
});

describe("deriveNameFromSource", () => {
  test("npm: prefix delegates to parseNpmPackageName", () => {
    expect(deriveNameFromSource("npm:@scope/pkg@1.0")).toBe("@scope/pkg");
  });

  test("plain path uses entryNameFromPath", () => {
    expect(deriveNameFromSource("/foo/my-ext.ts")).toBe("my-ext");
  });

  test("index.ts uses directory name", () => {
    expect(deriveNameFromSource("/foo/my-ext/index.ts")).toBe("my-ext");
  });
});

describe("sourceLabelForPath", () => {
  test("replaces home with ~", () => {
    expect(sourceLabelForPath(join(homedir(), "foo/bar.ts"))).toBe("~/foo/bar.ts");
  });

  test("non-home paths unchanged", () => {
    expect(sourceLabelForPath("/tmp/foo.ts")).toBe("/tmp/foo.ts");
  });
});

// ─── File Detection ─────────────────────────────────────────────────

describe("isExtensionFile", () => {
  test.each([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"])("recognizes %s", (ext) => {
    expect(isExtensionFile(`foo${ext}`)).toBe(true);
  });

  test.each([".py", ".json", ".md", ""])("rejects %s", (ext) => {
    expect(isExtensionFile(`foo${ext}`)).toBe(false);
  });

  test("case sensitive", () => {
    expect(isExtensionFile("foo.TS")).toBe(false);
  });
});

// ─── Package Parsing ────────────────────────────────────────────────

describe("parseNpmPackageName", () => {
  test("unscoped without version", () => {
    expect(parseNpmPackageName("lodash")).toBe("lodash");
  });

  test("unscoped with version", () => {
    expect(parseNpmPackageName("lodash@4.17.21")).toBe("lodash");
  });

  test("scoped without version", () => {
    expect(parseNpmPackageName("@scope/pkg")).toBe("@scope/pkg");
  });

  test("scoped with version", () => {
    expect(parseNpmPackageName("@scope/pkg@2.0.0")).toBe("@scope/pkg");
  });

  test("bare scoped org", () => {
    expect(parseNpmPackageName("@scope")).toBe("@scope");
  });
});

describe("packageSettingSource", () => {
  test("string setting returns itself", () => {
    expect(packageSettingSource("my-pkg")).toBe("my-pkg");
  });

  test("object with source returns source", () => {
    expect(packageSettingSource({ source: "my-pkg" })).toBe("my-pkg");
  });

  test("object without source returns undefined", () => {
    expect(packageSettingSource({ name: "nope" })).toBeUndefined();
  });

  test("null returns undefined", () => {
    expect(packageSettingSource(null as any)).toBeUndefined();
  });
});

describe("isOptionalPackageSetting", () => {
  test("object with source and empty extensions array", () => {
    expect(isOptionalPackageSetting({ source: "my-pkg", extensions: [] })).toBe(true);
  });

  test("object with source and non-empty extensions", () => {
    expect(isOptionalPackageSetting({ source: "my-pkg", extensions: ["foo"] })).toBe(false);
  });

  test("bare string is not optional", () => {
    expect(isOptionalPackageSetting("my-pkg")).toBe(false);
  });

  test("object without extensions field", () => {
    expect(isOptionalPackageSetting({ source: "my-pkg" })).toBe(false);
  });
});

describe("isManagedPackageSetting", () => {
  test("string is managed", () => {
    expect(isManagedPackageSetting("my-pkg")).toBe(true);
  });

  test("object with source and no extensions is managed", () => {
    expect(isManagedPackageSetting({ source: "my-pkg" })).toBe(true);
  });

  test("object with empty extensions is managed", () => {
    expect(isManagedPackageSetting({ source: "my-pkg", extensions: [] })).toBe(true);
  });

  test("object with non-empty extensions is NOT managed", () => {
    expect(isManagedPackageSetting({ source: "my-pkg", extensions: ["foo"] })).toBe(false);
  });

  test("object without source is not managed", () => {
    expect(isManagedPackageSetting({ name: "nope" })).toBe(false);
  });
});

describe("isPackageLikeSource", () => {
  test.each(["npm:x", "git:x", "http://x", "https://x", "ssh://x"])("recognizes %s", (src) => {
    expect(isPackageLikeSource(src)).toBe(true);
  });

  test.each(["file://x", "./local", "/abs/path"])("rejects %s", (src) => {
    expect(isPackageLikeSource(src)).toBe(false);
  });
});

// ─── Array Utilities ────────────────────────────────────────────────

describe("unique", () => {
  test("removes duplicates", () => {
    expect(unique([1, 2, 2, 3, 3, 3])).toEqual([1, 2, 3]);
  });

  test("preserves order", () => {
    expect(unique(["c", "a", "b", "a", "c"])).toEqual(["c", "a", "b"]);
  });

  test("empty array", () => {
    expect(unique([])).toEqual([]);
  });

  test("no duplicates", () => {
    expect(unique([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("removeStringFromArray", () => {
  test("removes all occurrences", () => {
    expect(removeStringFromArray(["a", "b", "a", "c"], "a")).toEqual(["b", "c"]);
  });

  test("no match returns same elements", () => {
    expect(removeStringFromArray(["a", "b"], "x")).toEqual(["a", "b"]);
  });
});

describe("addUniqueString", () => {
  test("adds when not present", () => {
    expect(addUniqueString(["a"], "b")).toEqual(["a", "b"]);
  });

  test("does not duplicate", () => {
    expect(addUniqueString(["a", "b"], "a")).toEqual(["a", "b"]);
  });
});

describe("findPackageIndex", () => {
  test("finds string package", () => {
    expect(findPackageIndex(["a", "b"], "b")).toBe(1);
  });

  test("finds object package by source", () => {
    expect(findPackageIndex([{ source: "a" }, { source: "b" }], "b")).toBe(1);
  });

  test("returns -1 when not found", () => {
    expect(findPackageIndex(["a"], "z")).toBe(-1);
  });
});

// ─── Lookup ─────────────────────────────────────────────────────────

describe("normalizeRequestedName", () => {
  test("trims whitespace", () => {
    expect(normalizeRequestedName("  hello  ")).toBe("hello");
  });

  test("empty string", () => {
    expect(normalizeRequestedName("")).toBe("");
  });

  test("only whitespace", () => {
    expect(normalizeRequestedName("   ")).toBe("");
  });
});

describe("findEntryByName", () => {
  const mkEntry = (name: string): OptionalEntry => ({
    name,
    sourceLabel: name,
    resolveFiles: () => [],
  });

  const registry = new Map([
    ["foo", mkEntry("foo")],
    ["Bar", mkEntry("Bar")],
  ]);

  test("exact match", () => {
    expect(findEntryByName(registry, "foo")?.name).toBe("foo");
  });

  test("case-insensitive match", () => {
    expect(findEntryByName(registry, "bar")?.name).toBe("Bar");
  });

  test("no match returns undefined", () => {
    expect(findEntryByName(registry, "baz")).toBeUndefined();
  });
});

describe("findPersistentItemByName", () => {
  const mkItem = (name: string): PersistentItem => ({
    name,
    mode: "startup",
    scope: "global",
    sourceLabel: name,
    kind: "auto-file",
    setMode: () => undefined,
  });

  const items = [mkItem("alpha"), mkItem("Beta")];

  test("exact match", () => {
    expect(findPersistentItemByName(items, "alpha")?.name).toBe("alpha");
  });

  test("case-insensitive match", () => {
    expect(findPersistentItemByName(items, "beta")?.name).toBe("Beta");
  });

  test("no match returns undefined", () => {
    expect(findPersistentItemByName(items, "gamma")).toBeUndefined();
  });
});

// ─── Display ────────────────────────────────────────────────────────

describe("formatPersistentLines", () => {
  const mkItem = (name: string, mode: "startup" | "optional", scope: "global" | "project"): PersistentItem => ({
    name,
    mode,
    scope,
    sourceLabel: `${name}-source`,
    kind: "auto-file",
    setMode: () => undefined,
  });

  test("empty items shows help text", () => {
    const lines = formatPersistentLines([], []);
    expect(lines[0]).toContain("No extension resources found");
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  test("startup item shows loaded + autoload on", () => {
    const lines = formatPersistentLines([mkItem("foo", "startup", "global")], []);
    expect(lines[0]).toContain("[loaded, autoload on]");
    expect(lines[0]).toContain("foo");
    expect(lines[0]).toContain("global");
  });

  test("optional item not enabled shows not loaded + autoload off", () => {
    const lines = formatPersistentLines([mkItem("foo", "optional", "global")], []);
    expect(lines[0]).toContain("[not loaded, autoload off]");
  });

  test("optional item enabled shows loaded + autoload off", () => {
    const lines = formatPersistentLines([mkItem("foo", "optional", "global")], ["foo"]);
    expect(lines[0]).toContain("[loaded, autoload off]");
  });

  test("items sorted by name then scope", () => {
    const items = [mkItem("beta", "startup", "project"), mkItem("alpha", "startup", "global"), mkItem("alpha", "startup", "project")];
    const lines = formatPersistentLines(items, []);
    expect(lines[0]).toContain("alpha");
    expect(lines[0]).toContain("global");
    expect(lines[1]).toContain("alpha");
    expect(lines[1]).toContain("project");
    expect(lines[2]).toContain("beta");
  });
});

// ─── Autocomplete ───────────────────────────────────────────────────

describe("completeNames", () => {
  const names = ["alpha", "Beta", "gammaExt"];

  test("empty prefix returns all", () => {
    const result = completeNames(names, "");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
  });

  test("prefix filters case-insensitively", () => {
    const result = completeNames(names, "al");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].value).toBe("alpha");
  });

  test("no match returns null", () => {
    expect(completeNames(names, "zzz")).toBeNull();
  });

  test("whitespace prefix treated as empty", () => {
    const result = completeNames(names, "  ");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
  });

  test("results are sorted", () => {
    const result = completeNames(["z", "a", "m"], "");
    expect(result!.map((r) => r.value)).toEqual(["a", "m", "z"]);
  });
});

// ─── Constants ──────────────────────────────────────────────────────

describe("constants", () => {
  test("dir name is correct", () => {
    expect(OPTIONAL_DIR_NAME).toBe("optional-extensions");
  });

  test("config name is correct", () => {
    expect(OPTIONAL_CONFIG_NAME).toBe("optional-extensions.json");
  });

  test("self name is correct", () => {
    expect(SELF_NAME).toBe("optional-extension-loader");
  });
});
