import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fixedDefaults from "./fixed-defaults.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function context(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

class PiHarness {
  readonly handlers = new Map<string, Handler[]>();

  readonly api = {
    on: (event: string, handler: Handler) => {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    },
  } as unknown as ExtensionAPI;

  async emit(event: string, payload: object, ctx: ExtensionContext) {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload as never, ctx);
    }
  }
}

describe("fixed-defaults", () => {
  test("restores model and thinking defaults without changing other settings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fixed-defaults-test-"));
    temporaryDirectories.push(directory);
    const cwd = join(directory, "project");
    const agentDir = join(directory, "agent");
    const settingsPath = join(agentDir, "settings.json");
    const original = {
      lastChangelogVersion: "0.83.0",
      defaultProvider: "zai",
      defaultModel: "glm-5.2",
      defaultThinkingLevel: "high",
      hideThinkingBlock: true,
      defaultProjectTrust: "always",
      packages: ["npm:example"],
    };
    mkdirForFile(settingsPath);
    writeFileSync(settingsPath, `${JSON.stringify(original, null, 2)}\n`);

    const pi = new PiHarness();
    fixedDefaults(pi.api, { agentDir });
    const ctx = context(cwd);

    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit(
      "model_select",
      {
        model: { provider: "zai", id: "glm-5.2" },
        previousModel: undefined,
        source: "set",
      },
      ctx,
    );
    await pi.emit(
      "thinking_level_select",
      { level: "high", previousLevel: "max" },
      ctx,
    );

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      ...original,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-luna",
      defaultThinkingLevel: "max",
    });
  });
});

function mkdirForFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
