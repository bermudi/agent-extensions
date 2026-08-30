import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CouncilOutput } from "./output.ts";

describe("CouncilOutput", () => {
  test("writes ordered JSONL and a private atomic design", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "council-output-"));
    const output = await CouncilOutput.create(cwd, "../../ Cache redesign !");
    await Promise.all([
      output.record("one", { value: 1 }),
      output.record("two", { value: 2 }),
      output.record("three", { value: 3 }),
    ]);
    await output.writeDesign("# Safe design\n");

    const events = (await readFile(output.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number; type: string });
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.type)).toEqual(["one", "two", "three"]);
    expect(output.directory.startsWith(join(cwd, ".pi", "council"))).toBe(true);
    expect(await readFile(output.designPath, "utf8")).toBe("# Safe design\n");
    expect((await stat(output.designPath)).mode & 0o777).toBe(0o600);
    expect(
      await readFile(join(cwd, ".pi", "council", ".gitignore"), "utf8"),
    ).toBe("*\n");
  });

  test("refuses symlinked output directories and files", async () => {
    const parent = await mkdtemp(join(tmpdir(), "council-output-link-"));
    const cwd = join(parent, "repo");
    const outside = join(parent, "outside");
    await mkdir(cwd);
    await mkdir(outside);
    await symlink(outside, join(cwd, ".pi"));
    await expect(CouncilOutput.create(cwd, "design")).rejects.toThrow(
      "symlinked council output path",
    );

    const second = await mkdtemp(join(tmpdir(), "council-output-file-"));
    await mkdir(join(second, ".pi", "council"), { recursive: true });
    const victim = join(parent, "victim");
    await writeFile(victim, "keep");
    await symlink(victim, join(second, ".pi", "council", ".gitignore"));
    await expect(CouncilOutput.create(second, "design")).rejects.toThrow(
      "symlinked council output file",
    );
    expect(await readFile(victim, "utf8")).toBe("keep");
  });
});
