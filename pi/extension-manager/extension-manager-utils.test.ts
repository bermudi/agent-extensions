import { describe, expect, test } from "bun:test";
import {
  expandHome,
  resolveMaybeRelative,
  isExtensionFile,
  unique,
  parseNpmPackageName,
  classifySource,
  buildSourceInfo,
  deriveNameFromSource,
  sourceLabelForPath,
  entryNameFromPath,
  isPackageLikeSource,
  completeNames,
  gitUrlToDirName,
  gitUrlToHttps,
  AGENT_EXTENSIONS_DIR,
  MANAGER_CONFIG_NAME,
  SELF_NAME,
} from "./extension-manager-utils.js";
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

  test("git source uses repo name", () => {
    expect(deriveNameFromSource("git:github.com/user/my-repo")).toBe("my-repo");
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
});

describe("isPackageLikeSource", () => {
  test.each(["npm:x", "git:x", "http://x", "https://x", "ssh://x"])("recognizes %s", (src) => {
    expect(isPackageLikeSource(src)).toBe(true);
  });

  test.each(["file://x", "./local", "/abs/path"])("rejects %s", (src) => {
    expect(isPackageLikeSource(src)).toBe(false);
  });
});

// ─── Source Classification ──────────────────────────────────────────

describe("classifySource", () => {
  test("git sources", () => {
    expect(classifySource("git:github.com/user/repo")).toBe("git");
    expect(classifySource("https://github.com/user/repo")).toBe("git");
    expect(classifySource("ssh://git@github.com/user/repo")).toBe("git");
  });

  test("npm sources", () => {
    expect(classifySource("npm:my-package")).toBe("npm");
    expect(classifySource("npm:@scope/pkg")).toBe("npm");
  });

  test("local sources", () => {
    expect(classifySource("/abs/path.ts")).toBe("local-file");
    expect(classifySource("./relative.ts")).toBe("local-file");
    expect(classifySource("~/path.ts")).toBe("local-file");
  });
});

describe("buildSourceInfo", () => {
  test("git source", () => {
    const info = buildSourceInfo("git:github.com/user/repo");
    expect(info.kind).toBe("git");
    expect(info.gitUrl).toBe("https://github.com/user/repo");
  });

  test("npm source", () => {
    const info = buildSourceInfo("npm:@scope/pkg");
    expect(info.kind).toBe("npm");
    expect(info.npmPackage).toBe("@scope/pkg");
  });

  test("local source", () => {
    const info = buildSourceInfo("/path/to/ext.ts");
    expect(info.kind).toBe("local-file");
    expect(info.localPath).toBe("/path/to/ext.ts");
  });
});

// ─── Git URL helpers ────────────────────────────────────────────────

describe("gitUrlToDirName", () => {
  test("git: prefix", () => {
    expect(gitUrlToDirName("git:github.com/user/repo")).toBe("github.com/user/repo");
  });

  test("strips .git suffix", () => {
    expect(gitUrlToDirName("git:github.com/user/repo.git")).toBe("github.com/user/repo");
  });
});

describe("gitUrlToHttps", () => {
  test("git: to https://", () => {
    expect(gitUrlToHttps("git:github.com/user/repo")).toBe("https://github.com/user/repo");
  });

  test("ssh://git@ to https://", () => {
    expect(gitUrlToHttps("ssh://git@github.com/user/repo")).toBe("https://github.com/user/repo");
  });

  test("already https://", () => {
    expect(gitUrlToHttps("https://github.com/user/repo")).toBe("https://github.com/user/repo");
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
    expect(result![0].value).toBe("alpha");
  });

  test("no match returns null", () => {
    expect(completeNames(names, "zzz")).toBeNull();
  });
});

// ─── Constants ──────────────────────────────────────────────────────

describe("constants", () => {
  test("extensions dir name", () => {
    expect(AGENT_EXTENSIONS_DIR).toBe("extensions");
  });

  test("config name", () => {
    expect(MANAGER_CONFIG_NAME).toBe("extension-manager.json");
  });

  test("self name", () => {
    expect(SELF_NAME).toBe("extension-manager");
  });
});
