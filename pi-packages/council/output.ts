import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { CouncilEvent } from "./types.ts";

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "design";
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing symlinked council output path: ${path}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Council output path is not a directory: ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await mkdir(path, { mode: 0o700 });
    } else {
      throw error;
    }
  }
  await chmod(path, 0o700);
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing symlinked council output file: ${path}`);
    }
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
}

export class CouncilOutput {
  readonly directory: string;
  readonly logPath: string;
  readonly designPath: string;
  private sequence = 0;
  private writes = Promise.resolve();

  private constructor(directory: string) {
    this.directory = directory;
    this.logPath = join(directory, "council.jsonl");
    this.designPath = join(directory, "DESIGN.md");
  }

  static async create(cwd: string, focus: string): Promise<CouncilOutput> {
    const piDirectory = join(cwd, ".pi");
    const root = join(piDirectory, "council");
    await ensurePrivateDirectory(piDirectory);
    await ensurePrivateDirectory(root);
    const ignorePath = join(root, ".gitignore");
    await rejectSymlink(ignorePath);
    await writeFile(ignorePath, "*\n", {
      mode: 0o600,
    });
    await chmod(ignorePath, 0o600);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const directory = join(root, `${stamp}-${slugify(focus)}`);
    await mkdir(directory, { mode: 0o700 });
    return new CouncilOutput(directory);
  }

  record(
    type: string,
    data: unknown,
    details: { actor?: string; phase?: string } = {},
  ): Promise<void> {
    const event: CouncilEvent = {
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      type,
      ...details,
      data,
    };
    this.writes = this.writes.then(() =>
      appendFile(this.logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 }),
    );
    return this.writes;
  }

  async writeDesign(markdown: string): Promise<void> {
    await this.writes;
    const temporary = `${this.designPath}.tmp`;
    await writeFile(temporary, markdown, { mode: 0o600 });
    await rename(temporary, this.designPath);
  }
}
