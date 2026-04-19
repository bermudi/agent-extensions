/**
 * Integration test for extension-manager — verifies extension loads into a real pi session.
 *
 * Uses pi's own createAgentSession + in-memory persistence to exercise the
 * full loading path without needing an LLM.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";

const EXTENSION_PATH = resolve(import.meta.dirname, "index.ts");

// ─── Test fixtures ──────────────────────────────────────────────────

function createFakeExtension(dir: string, name: string): string {
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, `
    import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
    export default function(pi: ExtensionAPI) {
      pi.registerCommand("${name}-ping", {
        description: "Test ping command from ${name}",
        handler: async (_args, ctx) => {
          ctx.ui.notify("${name} pong!", "success");
        },
      });
    }
  `);
  return file;
}

// ─── Session creation helper ────────────────────────────────────────

async function createTestEnv(extensionPaths: string[] = []) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ext-mgr-test-"));
  const agentDir = join(cwd, ".pi");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });

  // Create fake extensions for testing
  createFakeExtension(join(agentDir, "extensions"), "test-auto");
  mkdirSync(join(agentDir, "optional-extensions"), { recursive: true });
  createFakeExtension(join(agentDir, "optional-extensions"), "test-optional");

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: extensionPaths,
  });
  await loader.reload();

  const model = getModel("openai", "gpt-4o");

  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    model,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader: loader,
  });

  // Patch API key to bypass auth
  (session.agent as any).getApiKey = () => "test-key";
  const origModelRegistry = (session as any)._modelRegistry;
  if (origModelRegistry) {
    origModelRegistry.getApiKey = () => "test-key";
    origModelRegistry.getApiKeyForProvider = () => "test-key";
  }

  return { session, cwd, agentDir, extensionsResult, dispose: () => { session.dispose(); rmSync(cwd, { recursive: true, force: true }); } };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("extension-manager", () => {
  test("loads without errors and registers /ext command", async () => {
    const { session, extensionsResult, dispose } = await createTestEnv([EXTENSION_PATH]);

    try {
      expect(extensionsResult.errors).toEqual([]);

      // Check that /ext command was registered
      const allCommands = extensionsResult.extensions.flatMap((e: any) => [...(e.commands?.values() ?? [])]);
      const extCommand = allCommands.find((c: any) => c.name === "ext");
      expect(extCommand).toBeDefined();
      expect(extCommand.description).toContain("Manage extensions");
      expect(extCommand.description).toContain("Manage extensions");
    } finally {
      dispose();
    }
  });

  test("discovers auto-loaded extensions", async () => {
    const { session, extensionsResult, dispose } = await createTestEnv([EXTENSION_PATH]);

    try {
      expect(extensionsResult.errors).toEqual([]);

      // test-auto should be discovered and loaded
      const allCommands = extensionsResult.extensions.flatMap((e: any) => [...(e.commands?.values() ?? [])]);
      const pingCommand = allCommands.find((c: any) => c.name?.includes("test-auto-ping"));
      expect(pingCommand).toBeDefined();
    } finally {
      dispose();
    }
  });

  test("does NOT auto-load optional extensions", async () => {
    const { session, extensionsResult, dispose } = await createTestEnv([EXTENSION_PATH]);

    try {
      expect(extensionsResult.errors).toEqual([]);

      // test-optional should NOT be loaded
      const commands = session.extensionsRunner?.getRegisteredCommands?.() ?? [];
      const pingCommand = commands.find((c: any) => c.name?.includes("test-optional-ping"));
      expect(pingCommand).toBeUndefined();
    } finally {
      dispose();
    }
  });
});
