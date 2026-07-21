/**
 * prefer-tools — Enforce modern CLI tooling by blocking the legacy equivalents.
 *
 * Mechanism: a single `tool_call` handler runs a list of rules against every
 * `bash` command. Each rule matches a legacy command *token in command
 * position* and hard-blocks it with a reason pointing at the preferred tool:
 *
 *   rm                  → trash   (recoverable beats gone; per repo AGENTS.md)
 *   grep/egrep/fgrep    → rg      (ripgrep: faster, respects .gitignore)
 *   find                → fd      (simpler syntax, respects .gitignore)
 *   python/pip/pytest/  → uv      (per repo AGENTS.md: `uv` always)
 *     mypy
 *
 * Philosophy (per bermudi): block the *obvious* token and tell the model the
 * alternative. Do NOT try to catch creative bypasses (e.g. `git grep`, `find
 * -delete`, `xargs rm`, `rmdir`, `unlink`, `python3 -c` inside a script). A
 * guardrail, not a jail — the model is trusted to take the hint.
 *
 * Token matching: a legacy command is only matched in command position — at the
 * start of the string or after a shell separator (`\n ; | & < > ( ) /`),
 * optionally `sudo `-prefixed. A plain space does not count, so `echo rm` (rm
 * as an argument) is not blocked. A trailing `\b` keeps `rmdir`/`chmod`/`pipx`/
 * `pythonize` out.
 */

import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/**
 * Build a regex that matches `token` only in command position.
 * `token` must be a regex source fragment ending appropriately (a trailing
 * `\b` is appended here).
 */
function cmdToken(token: string): RegExp {
  // start-of-string OR one of: newline ; | & < > ( ) /
  // then optional whitespace and optional `sudo `
  return new RegExp(`(?:^|[\\n|;&<>()/])\\s*(?:sudo\\s+)?${token}\\b`);
}

interface Rule {
  re: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  {
    re: cmdToken("rm"),
    reason: "rm is blocked — use `trash` instead (recoverable beats gone)",
  },
  {
    re: cmdToken("[eEfF]?grep"),
    reason: "grep is blocked — use `rg` (ripgrep) instead",
  },
  {
    re: cmdToken("find"),
    reason: "find is blocked — use `fd` instead",
  },
  {
    re: cmdToken("(?:python3?|pip3?|pytest|mypy)"),
    reason:
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
  },
];

export default function preferTools(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command ?? "";
    for (const { re, reason } of RULES) {
      if (re.test(command)) {
        return { block: true, reason };
      }
    }
  });
}
