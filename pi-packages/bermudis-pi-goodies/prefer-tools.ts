/**
 * prefer-tools — Enforce modern CLI tooling by blocking the legacy equivalents.
 *
 * A small, quote/heredoc-aware lexer checks each `bash` command for legacy
 * tools in unquoted command position. Single-quoted strings, quoted heredoc
 * bodies, and plain arguments are literal. Everything bash actually executes
 * is parsed instead: `$(...)` and backtick substitutions — unquoted, inside
 * double quotes (they do NOT suppress substitution), inside `${...}` and
 * `$((...))` bodies — plus substitutions in unquoted heredoc bodies.
 * Env-var assignment prefixes (`FOO=bar rm x`) are recognized and skipped so
 * the real command that follows them is still checked.
 *
 *   rm                  -> trash
 *   python/pip/pytest/  -> uv
 *     mypy
 *
 * Model-conditional: on glm-5.* models, `rg` is also blocked — they invent
 * ripgrep flags. The built-in grep tool (structured args, no raw flags) and
 * bash `grep -rn` still work.
 */
import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

interface Rule {
  names: readonly string[];
  reason: string;
}

const RULES: Rule[] = [
  {
    names: ["rm"],
    reason: "rm is blocked — use `trash` instead (recoverable beats gone)",
  },
  {
    names: ["python", "python3", "pip", "pip3", "pytest", "mypy"],
    reason:
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
  },
];

/**
 * glm-5.* model ids hallucinate ripgrep flags; bash `rg` is blocked for them.
 * Matches "glm-5" as a family token: not preceded by an alphanumeric (so
 * Meta's xglm-564M doesn't match) and not followed by a digit (so glm-50,
 * glm-500 don't match). glm-5, glm-5.5, glm-5-turbo, glm-5:free,
 * provider-prefixed "kilo/glm-5" all match. glm-4.x is unaffected.
 */
export function isRipgrepBlockedModel(modelId: string | undefined): boolean {
  return (
    typeof modelId === "string" && /(^|[^a-z0-9])glm-5(?![0-9])/i.test(modelId)
  );
}

/** Extra rule appended when the active model is glm-5.*. */
export const RG_RULE: Rule = {
  names: ["rg"],
  reason:
    'rg is blocked for this model — it invents ripgrep flags. Use `grep -rn "pattern" path` instead (or pi\'s built-in grep tool).',
};

const COMMAND_PREFIX_KEYWORDS = new Set([
  "if",
  "while",
  "until",
  "then",
  "else",
  "elif",
  "do",
  "time",
  "!",
]);

const WORD_STOP = " \t\n\r|&;<>()\"'`$";

/**
 * `NAME=value` (or `NAME+=value`) in command position is an env-var
 * assignment, never the command itself — bash runs the word *after* it.
 * Without this check the lexer treated `FOO=bar` as the command, found no
 * rule match, demoted command position, and `rm`/`python` sailed through as
 * a mere argument (`FOO=bar rm x`, `PYTHONDONTWRITEBYTECODE=1 python x.py`).
 * The name must be a portable shell identifier, matching bash's own rule —
 * `1=2 x` is not an assignment in bash either (it is a command name, so the
 * real command never runs). readWord stops at `$`/quotes, so `FOO="a b"` and
 * `FOO=$(rm)` yield `FOO=` and still match.
 */
function isAssignmentWord(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word);
}

function matchCommand(
  name: string,
  rules: readonly Rule[],
): string | undefined {
  const base = name.includes("/")
    ? name.slice(name.lastIndexOf("/") + 1)
    : name;
  for (const rule of rules) {
    if (rule.names.includes(base)) return rule.reason;
  }
  return undefined;
}

function readWord(s: string, i: number): { word: string; next: number } {
  // Build the word char by char so backslash escapes strip the backslash:
  // `\rm` → `rm`, `foo\ bar` → `foo bar`. The old slice-based version kept
  // the backslash in the word, so `\rm` evaded matchCommand.
  let word = "";
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") break;
    if (c === "\\" && i + 1 < s.length) {
      word += s[i + 1];
      i += 2;
      continue;
    }
    if (WORD_STOP.includes(c)) break;
    word += c;
    i++;
  }
  return { word, next: i };
}

function readQuote(
  s: string,
  i: number,
  quote: string,
  escape: boolean,
): number {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (escape && c === "\\" && j + 1 < s.length) {
      j += 2;
      continue;
    }
    if (c === quote) {
      j++;
      break;
    }
    j++;
  }
  return j;
}

function skipBalancedParens(s: string, i: number, openLen: number): number {
  let depth = openLen === 3 ? 2 : 1;
  let j = i + openLen;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "'") {
      j = readQuote(s, j, "'", false);
      continue;
    }
    if (c === '"') {
      j = readQuote(s, j, '"', true);
      continue;
    }
    if (c === "`") {
      j = readQuote(s, j, "`", true);
      continue;
    }
    if (c === "$" && s.startsWith("$(", j)) {
      j++;
      continue;
    }
    if (c === "(") {
      depth++;
      j++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) return j + 1;
      j++;
      continue;
    }
    j++;
  }
  return s.length;
}

function skipBalancedBraces(s: string, i: number): number {
  let depth = 1;
  let j = i + 2;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "'") {
      j = readQuote(s, j, "'", false);
      continue;
    }
    if (c === '"') {
      j = readQuote(s, j, '"', true);
      continue;
    }
    if (c === "`") {
      j = readQuote(s, j, "`", true);
      continue;
    }
    if (c === "$" && s.startsWith("$(", j)) {
      j++;
      continue;
    }
    if (c === "{") {
      depth++;
      j++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0) return j + 1;
      j++;
      continue;
    }
    j++;
  }
  return s.length;
}

/**
 * Scan a region of source for command substitutions bash will actually
 * execute — `$(...)` and backticks — and return the matched rule's reason.
 *
 * Double quotes do NOT suppress substitution: `echo "$(rm x)"` runs `rm`
 * (bash-verified), so mode "double" scans their contents with `'` treated as
 * a literal character. Mode "plain" skips single-quoted spans (nothing runs
 * there) and descends into double-quoted ones.
 *
 * Only substitution constructs are recognized — a bare word is never taken
 * for a command, so arithmetic like `$(( rm + 1 ))` (a variable named `rm`)
 * stays allowed while `$(( $(rm) )` is caught. Callers use it for
 * double-quoted strings, backtick bodies, and the `${...}` / `$((...))`
 * bodies that readDollar otherwise skips wholesale.
 */
function scanExecutedSubs(
  s: string,
  start: number,
  end: number,
  rules: readonly Rule[],
  mode: "plain" | "double",
): string | undefined {
  let i = start;
  while (i < end) {
    const c = s[i];
    if (c === "\\") {
      // `"\$(rm)"` does not execute; `"\\$(rm)"` does — either way the
      // backslash and the char after it are consumed together.
      i += 2;
      continue;
    }
    if (mode === "plain") {
      if (c === "'") {
        i = readQuote(s, i, "'", false);
        continue;
      }
      if (c === '"') {
        const stop = readQuote(s, i, '"', true);
        const innerEnd = s[stop - 1] === '"' ? stop - 1 : stop;
        const reason = scanExecutedSubs(s, i + 1, innerEnd, rules, "double");
        if (reason) return reason;
        i = stop;
        continue;
      }
      const next = s[i + 1];
      if (c === "$" && (next === "'" || next === '"')) {
        // ANSI-C / locale strings only quote when unquoted; nothing runs
        // inside either way.
        i = readQuote(s, i + 1, next, true);
        continue;
      }
    } else if (c === '"') {
      // Defensive: callers pass the interior of one quoted string.
      i++;
      continue;
    }
    if (c === "`") {
      const stop = readQuote(s, i, "`", true);
      const innerEnd = s[stop - 1] === "`" ? stop - 1 : stop;
      const reason = detectLegacyTool(s.slice(i + 1, innerEnd), rules);
      if (reason) return reason;
      i = stop;
      continue;
    }
    if (c === "$" && s.startsWith("((", i + 1)) {
      // Arithmetic: not a substitution itself, but its body can contain one —
      // `$(( $(rm) + 1 ))` runs `rm`. The body itself is never parsed as a
      // command (see doc comment above). Regions inherit the quoting context
      // they appear in (arithmetic cannot legally contain quotes anyway).
      const stop = skipBalancedParens(s, i, 3);
      const innerEnd =
        s[stop - 1] === ")" && s[stop - 2] === ")" ? stop - 2 : stop;
      const reason = scanExecutedSubs(s, i + 3, innerEnd, rules, mode);
      if (reason) return reason;
      i = stop;
      continue;
    }
    if (c === "$" && s.startsWith("$(", i)) {
      const stop = skipBalancedParens(s, i, 2);
      const innerEnd = s[stop - 1] === ")" ? stop - 1 : stop;
      const reason = detectLegacyTool(s.slice(i + 2, innerEnd), rules);
      if (reason) return reason;
      i = stop;
      continue;
    }
    if (c === "$" && s.startsWith("${", i)) {
      // Parameter expansion runs substitutions inside: `${X:-$(rm)}`. The
      // enclosing mode carries over — bash-verified: quotes in an unquoted
      // expansion's word still quote (`${X:-'$(rm)'}` is literal), but inside
      // a double-quoted string those quotes are literal characters and the
      // substitution runs (`"${X:-'$(rm)'}"` executes).
      const stop = skipBalancedBraces(s, i);
      const innerEnd = s[stop - 1] === "}" ? stop - 1 : stop;
      const reason = scanExecutedSubs(s, i + 2, innerEnd, rules, mode);
      if (reason) return reason;
      i = stop;
      continue;
    }
    i++;
  }
  return undefined;
}

function readDollar(
  s: string,
  i: number,
  rules: readonly Rule[],
): { next: number; reason?: string } | null {
  if (i >= s.length || s[i] !== "$") return null;

  if (s.startsWith("$'", i)) {
    return { next: readQuote(s, i + 1, "'", true) };
  }
  if (s.startsWith("((", i + 1)) {
    // Arithmetic body: skip it, but scan for substitutions that execute
    // inside it — `$(( $(rm) + 1 ))` runs `rm`.
    const end = skipBalancedParens(s, i, 3);
    const innerEnd = s[end - 1] === ")" && s[end - 2] === ")" ? end - 2 : end;
    return {
      next: end,
      reason: scanExecutedSubs(s, i + 3, innerEnd, rules, "plain"),
    };
  }
  if (s.startsWith("(", i + 1)) {
    const end = skipBalancedParens(s, i, 2);
    const closeParen = end > 0 && s[end - 1] === ")" ? 1 : 0;
    const inner = s.slice(i + 2, end - closeParen);
    const reason = detectLegacyTool(inner, rules);
    return { next: end, reason };
  }
  if (s.startsWith("{", i + 1)) {
    // Parameter expansion body: `${X:-$(rm)}` executes `rm`.
    const end = skipBalancedBraces(s, i);
    const innerEnd = s[end - 1] === "}" ? end - 1 : end;
    return {
      next: end,
      reason: scanExecutedSubs(s, i + 2, innerEnd, rules, "plain"),
    };
  }
  if (i + 1 < s.length && /[0-9?@*#\-!$]/.test(s[i + 1])) {
    return { next: i + 2 };
  }
  let j = i + 1;
  while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
  return { next: j };
}

type Op =
  | { type: "separator"; next: number }
  | { type: "redirect"; next: number }
  | { type: "heredoc"; next: number; indented: boolean };

function readOperator(s: string, i: number): Op | null {
  const c = s[i];
  if (c === "<") {
    if (s.startsWith("<<-", i))
      return { type: "heredoc", next: i + 3, indented: true };
    if (s.startsWith("<<<", i)) return { type: "redirect", next: i + 3 };
    if (s.startsWith("<<", i))
      return { type: "heredoc", next: i + 2, indented: false };
    if (s.startsWith("<>", i) || s.startsWith("<&", i))
      return { type: "redirect", next: i + 2 };
    return { type: "redirect", next: i + 1 };
  }
  if (c === ">") {
    if (s.startsWith(">>", i)) return { type: "redirect", next: i + 2 };
    if (s.startsWith(">&", i)) return { type: "redirect", next: i + 2 };
    return { type: "redirect", next: i + 1 };
  }
  if (c === "&") {
    if (s.startsWith("&>>", i)) return { type: "redirect", next: i + 3 };
    if (s.startsWith("&&", i)) return { type: "separator", next: i + 2 };
    if (s.startsWith("&>", i)) return { type: "redirect", next: i + 2 };
    return { type: "separator", next: i + 1 };
  }
  if (c === "|") {
    if (s.startsWith("||", i)) return { type: "separator", next: i + 2 };
    if (s.startsWith("|&", i)) return { type: "separator", next: i + 2 };
    return { type: "separator", next: i + 1 };
  }
  if (c === ";") {
    if (s.startsWith(";;", i)) return { type: "separator", next: i + 2 };
    if (s.startsWith(";&", i)) return { type: "separator", next: i + 2 };
    return { type: "separator", next: i + 1 };
  }
  if (c === "(" || c === ")") return { type: "separator", next: i + 1 };
  return null;
}

function readHeredocDelimiter(
  s: string,
  i: number,
): { delimiter: string; next: number; quoted: boolean } | null {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  if (i >= s.length) return null;
  const c = s[i];
  if (c === "'" || c === '"') {
    const end = readQuote(s, i, c, c === '"');
    return { delimiter: s.slice(i + 1, end - 1), next: end, quoted: true };
  }
  const { word, next } = readWord(s, i);
  if (word.length === 0) return null;
  return { delimiter: word, next, quoted: false };
}

/**
 * Scan a single heredoc-body line for command substitutions bash will
 * execute. An unquoted heredoc body is double-quote-like: it expands
 * `$(...)` and backticks, and both quote characters are literal there —
 * bash-verified, `"$(rm)"` and `'$(rm)'` in the body both run. Only a
 * backslash suppresses expansion (`\$(rm)` is literal). Returns the matched
 * rule's reason if a blocked tool is found, undefined otherwise.
 */
function scanHeredocLineForCommandSubs(
  line: string,
  rules: readonly Rule[],
): string | undefined {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      i += 2;
      continue;
    }
    if (line.startsWith("$(", i)) {
      const end = skipBalancedParens(line, i, 2);
      const inner = line.slice(i + 2, end - 1);
      const reason = detectLegacyTool(inner, rules);
      if (reason) return reason;
      i = end;
      continue;
    }
    if (c === "`") {
      const end = readQuote(line, i, "`", true);
      const inner = line.slice(i + 1, end - 1);
      const reason = detectLegacyTool(inner, rules);
      if (reason) return reason;
      i = end;
      continue;
    }
    i++;
  }
  return undefined;
}

function skipHeredocBody(
  s: string,
  i: number,
  delimiter: string,
  indented: boolean,
  quoted: boolean,
  rules: readonly Rule[],
): { next: number; reason?: string } {
  let pos = i;
  while (pos <= s.length) {
    const nl = s.indexOf("\n", pos);
    const end = nl === -1 ? s.length : nl;
    let line = s.slice(pos, end);
    if (indented) line = line.replace(/^\t+/, "");
    if (line === delimiter) {
      return { next: nl === -1 ? s.length : nl + 1 };
    }
    // In unquoted heredocs, command substitutions execute — scan for
    // blocked tools inside $(...) and backticks.
    if (!quoted) {
      const reason = scanHeredocLineForCommandSubs(line, rules);
      if (reason) return { next: end, reason };
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return { next: s.length };
}

/** sudo options that consume the next word as their argument. */
const SUDO_OPTS_WITH_ARG = new Set([
  "-C",
  "-D",
  "-g",
  "-p",
  "-R",
  "-r",
  "-t",
  "-U",
  "-u",
  "--close-from",
  "--chdir",
  "--group",
  "--prompt",
  "--chroot",
  "--role",
  "--type",
  "--other-user",
  "--user",
]);

export function detectLegacyTool(
  command: string,
  extraRules: readonly Rule[] = [],
): string | undefined {
  const rules = extraRules.length > 0 ? [...RULES, ...extraRules] : RULES;
  let i = 0;
  let commandPos = true;
  // Set once an env-var assignment word is seen in the current simple
  // command; cleared wherever a new command starts (every `commandPos = true`
  // site). While it is set, quotes/expansions/redirect targets belonging to
  // the assignment must not demote command position.
  let assignmentPrefix = false;
  let sudoNext = false;
  let skipNextWord = false;
  let redirectTarget = false;
  let heredoc: {
    delimiter: string;
    indented: boolean;
    quoted: boolean;
    pending: boolean;
  } | null = null;

  while (i < command.length) {
    if (heredoc && !heredoc.pending) {
      const result = skipHeredocBody(
        command,
        i,
        heredoc.delimiter,
        heredoc.indented,
        heredoc.quoted,
        rules,
      );
      if (result.reason) return result.reason;
      i = result.next;
      heredoc = null;
      commandPos = true;
      assignmentPrefix = false;
      redirectTarget = false;
      sudoNext = false;
      skipNextWord = false;
      continue;
    }

    const c = command[i];

    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }

    if (c === "\n") {
      if (heredoc?.pending) {
        heredoc.pending = false;
      } else {
        commandPos = true;
      }
      assignmentPrefix = false;
      redirectTarget = false;
      sudoNext = false;
      skipNextWord = false;
      i++;
      continue;
    }

    if (c === "#") {
      const nl = command.indexOf("\n", i);
      if (nl === -1) break;
      if (heredoc?.pending) heredoc.pending = false;
      i = nl + 1;
      commandPos = true;
      assignmentPrefix = false;
      redirectTarget = false;
      sudoNext = false;
      skipNextWord = false;
      continue;
    }

    const op = readOperator(command, i);
    if (op) {
      i = op.next;
      if (op.type === "separator") {
        commandPos = true;
        assignmentPrefix = false;
        redirectTarget = false;
        sudoNext = false;
        skipNextWord = false;
      } else if (op.type === "redirect") {
        redirectTarget = true;
        sudoNext = false;
        skipNextWord = false;
      } else if (op.type === "heredoc") {
        const delim = readHeredocDelimiter(command, i);
        if (!delim) break;
        heredoc = {
          delimiter: delim.delimiter,
          indented: op.indented,
          quoted: delim.quoted,
          pending: true,
        };
        i = delim.next;
        commandPos = false;
        redirectTarget = false;
        sudoNext = false;
        skipNextWord = false;
      }
      continue;
    }

    // Brace group opener: `{` followed by whitespace starts a group; the
    // next word is in command position. Without this, `{ rm; }` evades
    // detection because `{` is read as a word and `rm` lands in argument
    // position.
    if (c === "{" && (i + 1 >= command.length || /\s/.test(command[i + 1]))) {
      i++;
      commandPos = true;
      assignmentPrefix = false;
      redirectTarget = false;
      sudoNext = false;
      skipNextWord = false;
      continue;
    }
    // Brace group closer: `}` at a word boundary (preceded by whitespace
    // or a separator) resets command position for the next word.
    if (c === "}" && (i === 0 || /\s|[;&|()]/.test(command[i - 1]))) {
      i++;
      commandPos = true;
      assignmentPrefix = false;
      redirectTarget = false;
      sudoNext = false;
      skipNextWord = false;
      continue;
    }

    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      const end = readQuote(command, i, quote, quote !== "'");
      // Double quotes and backticks execute their contents (single quotes
      // don't): `echo "$(rm x)"` and `echo \`rm x\`` must be caught like
      // their unquoted twin.
      if (quote === '"') {
        const innerEnd = command[end - 1] === '"' ? end - 1 : end;
        const reason = scanExecutedSubs(
          command,
          i + 1,
          innerEnd,
          rules,
          "double",
        );
        if (reason) return reason;
      } else if (quote === "`") {
        const innerEnd = command[end - 1] === "`" ? end - 1 : end;
        const reason = detectLegacyTool(command.slice(i + 1, innerEnd), rules);
        if (reason) return reason;
      }
      i = end;
      if (redirectTarget) redirectTarget = false;
      if (sudoNext) sudoNext = false;
      // Part of an assignment's value (`FOO="a b" rm x`) — not a command
      // word, so command position survives the quote.
      if (commandPos && !assignmentPrefix) commandPos = false;
      continue;
    }

    if (c === "$") {
      const d = readDollar(command, i, rules);
      if (d) {
        if (d.reason) return d.reason;
        i = d.next;
        if (redirectTarget) redirectTarget = false;
        if (sudoNext) sudoNext = false;
        // Same as quotes: `$VAR` / `$(...)` here expands an assignment value
        // (`FOO=$BASE rm x`), so it must not end command position either.
        if (commandPos && !assignmentPrefix) commandPos = false;
      } else {
        i++;
      }
      continue;
    }

    const { word, next } = readWord(command, i);
    if (word.length === 0) {
      i = next;
      continue;
    }
    i = next;

    if (redirectTarget) {
      redirectTarget = false;
      // A redirect target is never a command: `FOO=1 > /dev/null rm x` still
      // runs `rm`, so don't let the target end command position mid-assignment.
      if (!assignmentPrefix) commandPos = false;
      continue;
    }

    if (commandPos) {
      if (word === "sudo") {
        sudoNext = true;
        continue;
      }
      // Env-var assignment prefix: skip it and stay in command position so
      // the word after it (`rm`, `python`, …) is the one checked. Under
      // sudo it likewise keeps sudoNext armed (`sudo FOO=bar rm x`).
      if (isAssignmentWord(word) && !skipNextWord) {
        assignmentPrefix = true;
        continue;
      }
      if (sudoNext) {
        if (word.startsWith("-")) {
          // Options that take an argument consume the next word.
          if (SUDO_OPTS_WITH_ARG.has(word)) skipNextWord = true;
          continue;
        }
        if (skipNextWord) {
          skipNextWord = false;
          continue;
        }
        const reason = matchCommand(word, rules);
        if (reason) return reason;
        sudoNext = false;
      } else {
        if (skipNextWord) {
          skipNextWord = false;
          continue;
        }
        const reason = matchCommand(word, rules);
        if (reason) return reason;
      }
      if (!COMMAND_PREFIX_KEYWORDS.has(word)) {
        commandPos = false;
      }
    } else {
      commandPos = false;
    }
  }

  return undefined;
}

export default function preferTools(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    // Model-conditional rule: glm-5.* gets bash `rg` blocked (live model,
    // read per call — model switches mid-session take effect immediately).
    const extraRules = isRipgrepBlockedModel(ctx.model?.id) ? [RG_RULE] : [];
    const reason = detectLegacyTool(event.input.command ?? "", extraRules);
    if (reason) {
      return { block: true, reason };
    }
  });
}
