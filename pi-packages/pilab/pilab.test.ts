/** Tests for pilab. Everything runs against temp dirs via PILAB_ROOT /
 * PILAB_REAL_AGENT_DIR; the real ~/.pi/agent is never touched. The pi spawn
 * smoke test uses a PATH shim that records the env pi would receive. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_BORROW,
  PilabError,
  createSandbox,
  humanSince,
  listSandboxes,
  parseRunArgs,
  parseBorrowList,
  rmSandbox,
  runSandbox,
  sandboxPaths,
  setBorrow,
} from "./pilab.ts";

let REAL = "";
let ROOT = "";

function writeFile(p: string, text: string, mode?: number): void {
  writeFileSync(p, text);
  if (mode !== undefined) chmodSync(p, mode);
}

beforeAll(() => {
  REAL = mkdtempSync(join(tmpdir(), "pilab-real-"));
  ROOT = mkdtempSync(join(tmpdir(), "pilab-root-"));
  process.env.PILAB_REAL_AGENT_DIR = REAL;
  process.env.PILAB_ROOT = ROOT;

  // fake "real" agent dir, dots-style: settings carries leak-bait keys that
  // must never reach a sandbox
  writeFile(
    join(REAL, "settings.json"),
    JSON.stringify({
      defaultProvider: "kilo",
      defaultModel: "kilo/claude-sonnet-4",
      theme: "ashes-dark",
      tuiMode: "inline",
      packages: ["npm:bermudis-pi-goodies"],
      extensions: ["/should/never/leak.ts"],
      skills: ["/should/never/leak"],
      prompts: ["/should/never/leak"],
    }) + "\n",
  );
  writeFile(
    join(REAL, "auth.json"),
    JSON.stringify({ groq: { type: "api_key", key: "fake-test-value" } }),
  );
  writeFile(join(REAL, "keybindings.json"), "{}\n");
  writeFile(
    join(REAL, "models.json"),
    JSON.stringify({ providers: { commandcode: { baseUrl: "http://x" } } }),
  );
  writeFile(join(REAL, "AGENTS.md"), "# real global instructions\n");
  mkdirSync(join(REAL, "themes"));
  writeFile(join(REAL, "themes", "ashes-dark.json"), "{}\n");
});

afterAll(() => {
  delete process.env.PILAB_REAL_AGENT_DIR;
  delete process.env.PILAB_ROOT;
  rmSync(REAL, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

describe("createSandbox", () => {
  test("default borrows: layout, manifest, symlinks, settings allowlist", () => {
    const sb = createSandbox("alpha", new Set(DEFAULT_BORROW));
    expect(existsSync(sb.manifest)).toBe(true);
    const m = readJson(sb.manifest);
    expect(m.pilab).toBe(1);
    expect(m.name).toBe("alpha");
    expect(m.borrow).toEqual(["auth", "keybindings", "themes"]);

    // settings: allowlist copied, leak-bait absent
    const settings = readJson(join(sb.agent, "settings.json"));
    expect(settings.defaultProvider).toBe("kilo");
    expect(settings.theme).toBe("ashes-dark");
    expect(
      Object.keys(settings).every((k) =>
        [
          "defaultProvider",
          "defaultModel",
          "defaultThinkingLevel",
          "theme",
          "tuiMode",
        ].includes(k),
      ),
    ).toBe(true);
    expect(settings.packages).toBeUndefined();
    expect(settings.extensions).toBeUndefined();
    expect(settings.skills).toBeUndefined();
    expect(settings.prompts).toBeUndefined();

    // borrowed via live symlinks into the real store
    expect(lstatSync(join(sb.agent, "auth.json")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(sb.agent, "auth.json"))).toBe(
      resolve(join(REAL, "auth.json")),
    );
    expect(lstatSync(join(sb.agent, "keybindings.json")).isSymbolicLink()).toBe(
      true,
    );
    expect(
      lstatSync(join(sb.agent, "themes", "ashes-dark.json")).isSymbolicLink(),
    ).toBe(true);

    // not borrowed -> local scaffolds
    expect(lstatSync(join(sb.agent, "models.json")).isSymbolicLink()).toBe(
      false,
    );
    expect(readJson(join(sb.agent, "models.json")).providers).toEqual({});
    expect(readFileSync(join(sb.agent, "AGENTS.md"), "utf8")).toContain(
      "pilab sandbox",
    );
    expect(existsSync(join(sb.agent, "extensions"))).toBe(true);
  });

  test("empty borrows: nothing linked, scaffolds present", () => {
    const sb = createSandbox("bare", new Set());
    expect(existsSync(join(sb.agent, "auth.json"))).toBe(false);
    expect(existsSync(join(sb.agent, "keybindings.json"))).toBe(false);
    expect(existsSync(join(sb.agent, "themes"))).toBe(false);
    expect(readJson(sb.manifest).borrow).toEqual([]);
  });

  test("refuses duplicates, reserved names, and bad names", () => {
    expect(() => createSandbox("alpha", new Set())).toThrow(PilabError);
    expect(() => createSandbox("ls", new Set())).toThrow(PilabError);
    expect(() => createSandbox("../evil", new Set())).toThrow(PilabError);
    expect(() => createSandbox(".hidden", new Set())).toThrow(PilabError);
    expect(() => createSandbox("a/b", new Set())).toThrow(PilabError);
    expect(() => sandboxPaths("ok-name.1")).not.toThrow();
  });
});

describe("borrow / unborrow", () => {
  test("models cycle: symlink <-> local scaffold, manifest follows", () => {
    createSandbox("beta", new Set());
    setBorrow("beta", ["models"], true);
    expect(readJson(sandboxPaths("beta").manifest).borrow).toContain("models");
    expect(
      lstatSync(
        join(sandboxPaths("beta").agent, "models.json"),
      ).isSymbolicLink(),
    ).toBe(true);
    expect(realpathSync(join(sandboxPaths("beta").agent, "models.json"))).toBe(
      resolve(join(REAL, "models.json")),
    );

    setBorrow("beta", ["models"], false);
    expect(readJson(sandboxPaths("beta").manifest).borrow).toEqual([]);
    const p = join(sandboxPaths("beta").agent, "models.json");
    expect(existsSync(p)).toBe(true);
    expect(lstatSync(p).isSymbolicLink()).toBe(false);
  });

  test("re-borrow replaces the pilab scaffold, never a user file", () => {
    // scaffold we wrote -> may be replaced by the borrow
    setBorrow("beta", ["agents"], true);
    expect(
      lstatSync(join(sandboxPaths("beta").agent, "AGENTS.md")).isSymbolicLink(),
    ).toBe(true);
    setBorrow("beta", ["agents"], false);
    // user-edited local file -> borrow must refuse to clobber it
    const local = join(sandboxPaths("beta").agent, "AGENTS.md");
    writeFile(local, "# my precious sandbox instructions\n");
    setBorrow("beta", ["agents"], true);
    expect(lstatSync(local).isSymbolicLink()).toBe(false);
    expect(readFileSync(local, "utf8")).toContain("my precious");
  });

  test("idempotent and validates ids", () => {
    setBorrow("beta", ["auth"], true);
    setBorrow("beta", ["auth"], true);
    expect(readJson(sandboxPaths("beta").manifest).borrow).toContain("auth");
    expect(() => setBorrow("beta", ["nope" as never], true)).toThrow(
      PilabError,
    );
    expect(() => parseBorrowList("models,nonsense")).toThrow(PilabError);
    expect([...parseBorrowList("models, agents")]).toEqual([
      "models",
      "agents",
    ]);
  });
});

describe("parseRunArgs", () => {
  test("--model and --ext build pi args, -- passes through verbatim", () => {
    const extFile = join(ROOT, "some-ext.ts");
    writeFile(extFile, "export default () => {};\n");
    const spec = parseRunArgs([
      "--model",
      "kilo/claude-sonnet-4",
      "--ext",
      extFile,
      "--",
      "--system-prompt",
      "be nice",
      "-nc",
    ]);
    expect(spec.piArgs).toEqual([
      "-e",
      resolve(extFile),
      "--model",
      "kilo/claude-sonnet-4",
      "--system-prompt",
      "be nice",
      "-nc",
    ]);
  });

  test("empty passthrough and = forms", () => {
    expect(parseRunArgs(["--"]).piArgs).toEqual([]);
    expect(parseRunArgs(["--model=x/y"]).piArgs).toEqual(["--model", "x/y"]);
  });

  test("creation borrows parse", () => {
    expect([...parseRunArgs(["--borrow", "models,agents"]).borrow!]).toEqual([
      "models",
      "agents",
    ]);
    expect(parseRunArgs(["--no-borrow"]).borrow!.size).toBe(0);
    expect(parseRunArgs([]).borrow).toBeUndefined();
  });

  test("rejects typos and stray positionals instead of silently misrouting them", () => {
    expect(() => parseRunArgs(["--ext", "/no/such/file.ts"])).toThrow(
      PilabError,
    );
    expect(() => parseRunArgs(["--sysetm-prompt", "x"])).toThrow(PilabError);
    expect(() => parseRunArgs(["positional"])).toThrow(PilabError);
    expect(() => parseRunArgs(["--model"])).toThrow(PilabError);
    expect(() => parseRunArgs(["-e", "x"])).toThrow(PilabError);
  });
});

describe("rm", () => {
  test("uses trash CLI when available", () => {
    createSandbox("doomed", new Set());
    const shimDir = mkdtempSync(join(tmpdir(), "pilab-trash-"));
    const dest = join(shimDir, "dest");
    mkdirSync(dest);
    const log = join(shimDir, "log");
    // behaves like trash: records the call AND removes the path
    writeFile(
      join(shimDir, "trash"),
      `#!/bin/sh\nset -e\nexport PATH=/usr/bin:/bin\necho "$@" >> ${JSON.stringify(log)}\nmv "$1" ${JSON.stringify(dest)}\n`,
      0o755,
    );
    const oldPath = process.env.PATH;
    process.env.PATH = shimDir;
    try {
      rmSandbox("doomed");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
    expect(readFileSync(log, "utf8")).toContain(sandboxPaths("doomed").dir);
    expect(existsSync(sandboxPaths("doomed").dir)).toBe(false);
    rmSync(shimDir, { recursive: true, force: true });
  });

  test("falls back to <root>/.trash/ when trash is missing", () => {
    createSandbox("doomed2", new Set());
    const emptyDir = mkdtempSync(join(tmpdir(), "pilab-notrash-"));
    const oldPath = process.env.PATH;
    process.env.PATH = emptyDir;
    try {
      rmSandbox("doomed2");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
    expect(existsSync(sandboxPaths("doomed2").dir)).toBe(false);
    const trashDir = join(ROOT, ".trash");
    expect(readdirNames(trashDir).some((n) => n.startsWith("doomed2-"))).toBe(
      true,
    );
    rmSync(emptyDir, { recursive: true, force: true });
  });

  test("refuses unknown sandboxes", () => {
    expect(() => rmSandbox("ghost")).toThrow(PilabError);
  });
});

function readdirNames(p: string): string[] {
  return readdirSync(p);
}

describe("runSandbox", () => {
  test("spawns pi with PI_CODING_AGENT_DIR inside the sandbox; drops fighting env; cleans SIGINT shield", async () => {
    createSandbox("gamma", new Set(DEFAULT_BORROW));
    const shimDir = mkdtempSync(join(tmpdir(), "pilab-pi-"));
    const spy = join(shimDir, "spy");
    writeFile(
      join(shimDir, "pi"),
      `#!/bin/sh
echo "$PI_CODING_AGENT_DIR" >> ${JSON.stringify(spy)}
echo "PKG:\${PI_PACKAGE_DIR-unset}" >> ${JSON.stringify(spy)}
echo "SESSION:\${PI_CODING_AGENT_SESSION_DIR-unset}" >> ${JSON.stringify(spy)}
exit 7
`,
      0o755,
    );
    const oldPath = process.env.PATH;
    const oldPkg = process.env.PI_PACKAGE_DIR;
    const oldSess = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PATH = shimDir;
    process.env.PI_PACKAGE_DIR = "should-not-reach-pi";
    process.env.PI_CODING_AGENT_SESSION_DIR = "also-not";
    const sigintBefore = process.listenerCount("SIGINT");
    let code = -1;
    try {
      code = await runSandbox("gamma", ["--model", "x/y"]);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldPkg === undefined) delete process.env.PI_PACKAGE_DIR;
      else process.env.PI_PACKAGE_DIR = oldPkg;
      if (oldSess === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = oldSess;
    }
    expect(code).toBe(7); // exit code propagated
    const lines = readFileSync(spy, "utf8").trim().split("\n");
    expect(lines[0]).toBe(sandboxPaths("gamma").agent);
    expect(lines[1]).toBe("PKG:unset");
    expect(lines[2]).toBe("SESSION:unset");
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore); // shield removed
    expect(readJson(sandboxPaths("gamma").manifest).lastUsed).toBeDefined();
    rmSync(shimDir, { recursive: true, force: true });
  });
});

describe("listSandboxes", () => {
  test("lists sandboxes, most recently used first, skips non-sandboxes", () => {
    mkdirSync(join(ROOT, "not-a-sandbox"));
    mkdirSync(join(ROOT, ".hidden-dir"));
    const names = listSandboxes().map((x) => x.sb.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).not.toContain("not-a-sandbox");
    expect(names).not.toContain(".hidden-dir");
  });
});

describe("misc", () => {
  test("humanSince", () => {
    expect(humanSince(undefined)).toBe("never used");
    expect(humanSince("not-a-date")).toBe("never used");
    expect(humanSince(new Date(Date.now() - 120_000).toISOString())).toBe(
      "2m ago",
    );
  });
  if (!process.stdin.isTTY) {
    test("pick without a TTY bails out instead of hanging", async () => {
      const { pick } = await import("./pilab.ts");
      expect(
        await pick({ title: "t", multi: false, rows: [{ text: "a" }] }),
      ).toBeNull();
    });
  }
});
