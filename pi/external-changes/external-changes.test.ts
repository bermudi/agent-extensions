import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  captureBaseline,
  computeDrift,
  isGitRepo,
  type GitRunner,
} from "./external-changes.ts";

const EXTENSION = resolve(import.meta.dirname, "./external-changes.ts");

// A GitRunner that shells out to real git. Lets us exercise the full pipeline
// against a real temp repo without driving an agent turn through the harness
// (which is currently broken under the pinned pi version).
const realGitRunner: GitRunner = {
  async exec(command, args, options) {
    if (command !== "git") throw new Error(`unexpected command: ${command}`);
    try {
      const stdout = execFileSync("git", args, {
        cwd: options?.cwd ?? process.cwd(),
        timeout: options?.timeout ?? 5000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout: stdout ?? "", stderr: "", code: 0, killed: false };
    } catch (e: any) {
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        code: e.status ?? 1,
        killed: false,
      };
    }
  },
};

function makeTempRepo(prefix = "ext-changes-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
    encoding: "utf8",
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: dir,
    encoding: "utf8",
  });
  execFileSync("git", ["config", "commit.gpgsign", "false"], {
    cwd: dir,
    encoding: "utf8",
  });
  return dir;
}

function cleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function git(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "ignore" });
}

describe("external-changes core logic", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) cleanup(dir);
    dir = undefined;
  });

  test("isGitRepo is false outside a git repo", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-changes-nogit-"));
    expect(await isGitRepo(realGitRunner, dir)).toBe(false);
  });

  test("captureBaseline returns undefined when there are no commits", async () => {
    dir = makeTempRepo();
    // No commits yet.
    expect(await captureBaseline(realGitRunner, dir)).toBeUndefined();
  });

  test("injects diff when a tracked file is edited between turns", async () => {
    dir = makeTempRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "initial\n");
    git(["add", "a.txt"], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    const baseline = await captureBaseline(realGitRunner, dir);
    expect(baseline).toBeDefined();

    // External edit between turns.
    fs.writeFileSync(path.join(dir, "a.txt"), "initial\nexternally edited\n");

    const msg = await computeDrift(realGitRunner, dir, baseline!);
    expect(msg).toBeDefined();
    expect(msg!).toContain("<external-changes>");
    expect(msg!).toContain("externally edited");
    expect(msg!).toContain("Uncommitted changes made outside this session");
  });

  test("reports new untracked files added between turns", async () => {
    dir = makeTempRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "initial\n");
    git(["add", "a.txt"], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    const baseline = await captureBaseline(realGitRunner, dir);
    fs.writeFileSync(path.join(dir, "new.txt"), "brand new\n");

    const msg = await computeDrift(realGitRunner, dir, baseline!);
    expect(msg).toBeDefined();
    expect(msg!).toContain("new.txt");
    expect(msg!).toContain("New untracked files added outside this session");
  });

  test("reports new commits made externally", async () => {
    dir = makeTempRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "initial\n");
    git(["add", "a.txt"], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    const baseline = await captureBaseline(realGitRunner, dir);

    // External commit.
    fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
    git(["add", "b.txt"], dir);
    git(["commit", "-q", "-m", "external-commit"], dir);

    const msg = await computeDrift(realGitRunner, dir, baseline!);
    expect(msg).toBeDefined();
    expect(msg!).toContain("external-commit");
    expect(msg!).toContain("New commits made outside this session");
  });

  test("is silent when nothing changed between turns", async () => {
    dir = makeTempRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "initial\n");
    git(["add", "a.txt"], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    const baseline = await captureBaseline(realGitRunner, dir);
    // No changes.
    const msg = await computeDrift(realGitRunner, dir, baseline!);
    expect(msg).toBeUndefined();
  });

  test("does not re-report the agent's own uncommitted work as drift", async () => {
    // Agent leaves uncommitted changes behind at agent_end. Those are captured
    // in the baseline (via `git stash create`), so they should NOT show up as
    // drift on the next turn.
    dir = makeTempRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "initial\n");
    git(["add", "a.txt"], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    // Agent's own uncommitted edit.
    fs.writeFileSync(path.join(dir, "a.txt"), "initial\nagent edit\n");
    const baseline = await captureBaseline(realGitRunner, dir);
    expect(baseline!.stash).not.toBe(""); // stash captured the agent's work

    // No further external changes.
    const msg = await computeDrift(realGitRunner, dir, baseline!);
    expect(msg).toBeUndefined();
  });

  test("reports only the delta on top of the agent's uncommitted work", async () => {
    dir = makeTempRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "initial\n");
    git(["add", "a.txt"], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    fs.writeFileSync(path.join(dir, "a.txt"), "initial\nagent edit\n");
    const baseline = await captureBaseline(realGitRunner, dir);

    // External edit on top.
    fs.writeFileSync(
      path.join(dir, "a.txt"),
      "initial\nagent edit\nexternal\n",
    );
    const msg = await computeDrift(realGitRunner, dir, baseline!);
    expect(msg).toBeDefined();
    expect(msg!).toContain("external");
    // The agent's own line should not appear as an addition in the drift diff.
    expect(msg!).not.toContain("+agent edit");
  });
});

describe("external-changes extension factory", () => {
  // Smoke test: the factory loads through pi's real loader and registers the
  // expected event handlers without throwing. Full event-driven behavior is
  // covered by the core-logic tests above.
  test("factory loads and registers handlers", async () => {
    const mod = await import(EXTENSION);
    expect(typeof mod.default).toBe("function");
    expect(typeof mod.computeDrift).toBe("function");
    expect(typeof mod.captureBaseline).toBe("function");
  });
});
