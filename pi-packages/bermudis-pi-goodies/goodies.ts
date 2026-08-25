/**
 * Feature toggles for bermudis-pi-goodies.
 *
 * Lets you turn individual parts of the bundle on/off without losing the rest.
 * Example: if clean-tui freezes pi, run `/goodies disable clean-tui` and keep
 * kilo, provider-balance, etc.
 *
 * State persists to ~/.pi/agent/goodies.json. Changes take effect immediately
 * for most features; some (like clean-tui's tool overrides) may need a
 * `/reload` or new session to fully detach.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let CONFIG_PATH = join(homedir(), ".pi", "agent", "goodies.json");

export function __setConfigPathForTesting(path: string): void {
  CONFIG_PATH = path;
  config = loadConfig();
}

type FeatureName =
  | "copy-with-model"
  | "copy-trajectory"
  | "name-with-ai"
  | "zed"
  | "prefer-tools"
  | "keep-model"
  | "clean-tui"
  | "review"
  | "kilo"
  | "provider-balance"
  | "tps";

const FEATURES: FeatureName[] = [
  "copy-with-model",
  "copy-trajectory",
  "name-with-ai",
  "zed",
  "prefer-tools",
  "keep-model",
  "clean-tui",
  "review",
  "kilo",
  "provider-balance",
  "tps",
];

type Config = Partial<Record<FeatureName, boolean>>;

function loadConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as Config;
  } catch {
    return {};
  }
}

function saveConfig(config: Config): void {
  try {
    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  } catch (err) {
    console.error("goodies: failed to save config", err);
  }
}

let config = loadConfig();

export function isEnabled(name: FeatureName): boolean {
  return config[name] !== false; // default true
}

export function setEnabled(name: FeatureName, enabled: boolean): void {
  config[name] = enabled;
  saveConfig(config);
}

export function listFeatures(): Array<{ name: FeatureName; enabled: boolean }> {
  return FEATURES.map((name) => ({ name, enabled: isEnabled(name) }));
}

export default function goodies(pi: ExtensionAPI): void {
  pi.registerCommand("goodies", {
    description: "Toggle bermudis-pi-goodies features on/off",
    getArgumentCompletions: (prefix) => {
      const subcommands = ["list", "enable", "disable"];
      const parts = prefix.trim().split(/\s+/);
      if (parts.length <= 1) {
        return subcommands
          .filter((s) => s.startsWith(parts[0] || ""))
          .map((s) => ({ value: s, label: s }));
      }
      if (parts.length === 2 && ["enable", "disable"].includes(parts[0])) {
        return FEATURES.filter((f) => f.startsWith(parts[1] || "")).map(
          (f) => ({ value: f, label: f }),
        );
      }
      return null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] || "list";

      if (sub === "list") {
        const lines = listFeatures().map(
          ({ name, enabled }) =>
            `${enabled ? "✓" : "✗"} ${name}${enabled ? "" : " (disabled)"}`,
        );
        ctx.ui.notify(`goodies features:\n${lines.join("\n")}`, "info");
        return;
      }

      if (sub === "enable" || sub === "disable") {
        const name = parts[1] as FeatureName | undefined;
        if (!name || !FEATURES.includes(name)) {
          ctx.ui.notify(
            `Unknown feature "${name}". Available: ${FEATURES.join(", ")}`,
            "warning",
          );
          return;
        }
        const enabled = sub === "enable";
        setEnabled(name, enabled);
        ctx.ui.notify(
          `${name} ${enabled ? "enabled" : "disabled"}. ` +
            (name === "clean-tui" || name === "prefer-tools"
              ? "Run /reload or start a new session for tool overrides to fully detach."
              : "Takes effect immediately."),
          "info",
        );
        return;
      }

      ctx.ui.notify(
        `Usage: /goodies [list|enable <feature>|disable <feature>]`,
        "warning",
      );
    },
  });
}
