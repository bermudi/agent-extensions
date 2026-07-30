import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const critiqueCliPath = resolve(
  packageRoot,
  "node_modules/critique/src/cli.tsx",
);
const piAcpPath = resolve(packageRoot, "node_modules/.bin/pi-acp");

type Quote = "single" | "double";

type CritiqueResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
};

export function usePiForReview(
  args: string[],
  agentCommand = piAcpPath,
): string[] {
  if (args[0] !== "review") return args;

  const hasExplicitAgent = args.some(
    (arg) =>
      arg === "--agent" ||
      arg.startsWith("--agent=") ||
      arg === "--agent-command" ||
      arg.startsWith("--agent-command="),
  );
  if (hasExplicitAgent) return args;

  return ["review", "--agent-command", agentCommand, ...args.slice(1)];
}

export function parseCommandArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: Quote | undefined;
  let escaping = false;
  let tokenStarted = false;

  const finishToken = () => {
    if (!tokenStarted) return;
    args.push(current);
    current = "";
    tokenStarted = false;
  };

  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    if (quote === "single") {
      if (character === "'") quote = undefined;
      else current += character;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (quote === "double") {
      if (character === '"') quote = undefined;
      else current += character;
      continue;
    }

    if (character === "'") {
      quote = "single";
      tokenStarted = true;
    } else if (character === '"') {
      quote = "double";
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      finishToken();
    } else {
      current += character;
      tokenStarted = true;
    }
  }

  if (escaping) throw new Error("Trailing escape in arguments");
  if (quote) throw new Error(`Unterminated ${quote} quote in arguments`);

  finishToken();
  return args;
}

function runCritique(args: string[], cwd: string): CritiqueResult {
  // Critique shares the foreground process group. Keep Ctrl-C from terminating
  // the parent Pi while the synchronous child owns the terminal.
  const preserveParentOnSigint = () => {};
  process.on("SIGINT", preserveParentOnSigint);

  try {
    const result = spawnSync("bun", [critiqueCliPath, ...args], {
      cwd,
      env: process.env,
      stdio: "inherit",
    });

    return {
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
    };
  } finally {
    process.off("SIGINT", preserveParentOnSigint);
  }
}

export default function critiqueExtension(pi: ExtensionAPI) {
  pi.registerCommand("critique", {
    description: "Open or AI-review the current repository diff in Critique",
    handler: async (rawArgs, ctx) => {
      await ctx.waitForIdle();

      if (ctx.mode !== "tui") {
        ctx.ui.notify("/critique requires Pi's interactive TUI", "error");
        return;
      }

      if (!existsSync(critiqueCliPath)) {
        ctx.ui.notify(
          "Critique is not installed. Run bun install in the pi-critique package.",
          "error",
        );
        return;
      }

      let args: string[];
      try {
        args = usePiForReview(parseCommandArguments(rawArgs));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Invalid /critique arguments: ${message}`, "error");
        return;
      }

      if (
        args[0] === "review" &&
        args.includes(piAcpPath) &&
        !existsSync(piAcpPath)
      ) {
        ctx.ui.notify(
          "pi-acp is not installed. Run bun install in the pi-critique package.",
          "error",
        );
        return;
      }

      ctx.ui.setStatus("critique", "opening Critique");
      let result: CritiqueResult | undefined;

      try {
        result = await ctx.ui.custom<CritiqueResult>(
          (tui, _theme, _keybindings, done) => {
            let processResult: CritiqueResult;
            tui.stop();

            try {
              process.stdout.write("\x1b[2J\x1b[H");
              processResult = runCritique(args, ctx.cwd);
            } catch (error) {
              processResult = {
                status: null,
                signal: null,
                error: error instanceof Error ? error.message : String(error),
              };
            } finally {
              tui.start();
              tui.requestRender(true);
            }

            done(processResult);
            return { render: () => [], invalidate: () => {} };
          },
        );
      } finally {
        ctx.ui.setStatus("critique", undefined);
      }

      if (!result) {
        ctx.ui.notify("Critique did not start", "error");
      } else if (result.error) {
        ctx.ui.notify(`Failed to launch Critique: ${result.error}`, "error");
      } else if (result.signal) {
        ctx.ui.notify(`Critique exited after ${result.signal}`, "warning");
      } else if (result.status !== 0) {
        ctx.ui.notify(
          `Critique exited with status ${result.status ?? "unknown"}`,
          "error",
        );
      }
    },
  });
}
