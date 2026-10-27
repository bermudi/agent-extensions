/**
 * prefer-tools — Enforce modern CLI tooling by blocking the legacy equivalents.
 *
 * A small, quote/heredoc-aware lexer checks each `bash` command for legacy
 * tools in command position. One word reader handles both command names and
 * arguments, removing quotes and backslash-newline continuations without
 * confusing a continued line with a new command. Quoted heredoc bodies and
 * plain arguments are literal. Executed substitutions are scanned: `$(...)`
 * and backticks — unquoted, inside double quotes (which do NOT suppress
 * substitution), inside `${...}` and
 * `$((...))` bodies — plus substitutions in unquoted heredoc bodies.
 * Env-var assignment prefixes (`FOO=bar rm x`) are recognized and skipped so
 * the real command that follows them is still checked.
 * This is an accidental-misuse nudge, not a shell evaluator or a security
 * boundary: no variable/glob expansion, aliases, or parsing of eval/bash -c.
 *
 *   rm                  -> trash <path>   (moves to the trash can; recoverable)
 *   trash-rm            -> blocked       (permanently deletes from the trash can)
 *   trash-empty         -> blocked       (permanently empties the trash can)
 *
 * python/pip/pytest/mypy are deliberately NOT blocked (removed 2026-10-24):
 * steering those is AGENTS.md's job ("uv always"), not the hook's — telling
 * "inline" python apart from script-file python would need a bash-semantics
 * matrix, and the uv block fired mostly as friction after the fact.
 *
 * `rg` is allowed, but its replace flag is not: `-r` is ripgrep's
 * `--replace`, so `rg -rn` silently replaces matches with "n" instead of
 * showing line numbers. Any short-option cluster containing `r` is blocked;
 * spell out `--replace` if you actually mean it. The built-in grep tool
 * (structured args, no raw flags) and bash `grep -rn` still work.
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
    reason:
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
  },
  {
    names: ["trash-rm", "trash-empty"],
    reason:
      "trash-rm and trash-empty are blocked — they delete permanently from the trash can. Use `trash <path>` to move files to the trash (recoverable).",
  },
];

/**
 * `rg -r` is ripgrep's `--replace`, not "recursive": it replaces matched text
 * in the output, so `rg -rn` replaces with "n" and shows no line numbers
 * (machine lore: it once spawned a phantom `[ln]` log tag). Block the short
 * flag in any cluster, but allow the explicit long form as the escape hatch.
 */
export const RG_REPLACE_REASON =
  '`rg -r` is `--replace` — it silently replaces matched text in the output (`rg -rn` replaces with "n" instead of showing line numbers). If you really mean it, use `--replace` explicitly.';

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
 * rule match, demoted command position, and `rm` sailed through as
 * a mere argument (`FOO=bar rm x`).
 * The name must be a portable shell identifier, matching bash's own rule —
 * `1=2 x` is not an assignment in bash either (it is a command name, so the
 * real command never runs). Called on the raw source of a whole word, so
 * quoted/expanded values (`FOO="a b"`, `FOO=$BASE`) still match.
 */
function isAssignmentWord(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word);
}

function commandBase(name: string): string {
  return name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
}

function matchCommand(name: string): string | undefined {
  const base = commandBase(name);
  for (const rule of RULES) {
    if (rule.names.includes(base)) return rule.reason;
  }
  return undefined;
}

/**
 * Match a command word, plus the one argument-sensitive rule: an `rg`
 * invocation that uses the replace flag. `argStart` is the offset just past
 * the command word, where its arguments begin.
 */
function matchCommandAt(
  command: string,
  word: string,
  argStart: number,
): string | undefined {
  if (commandBase(word) === "rg" && rgUsesReplaceFlag(command, argStart)) {
    return RG_REPLACE_REASON;
  }
  return matchCommand(word);
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
    // Quotes inside a substitution belong to that nested command, not to
    // the surrounding string: `"$(rg "needle" -rn file)"`.
    if (quote === '"') {
      if (s.startsWith("$(", j)) {
        j = skipBalancedParens(s, j, s.startsWith("$((", j) ? 3 : 2);
        continue;
      }
      if (s.startsWith("${", j)) {
        j = skipBalancedBraces(s, j);
        continue;
      }
      if (c === "`") {
        j = readQuote(s, j, "`", true);
        continue;
      }
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
        const reason = scanExecutedSubs(s, i + 1, innerEnd, "double");
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
      const reason = detectLegacyTool(s.slice(i + 1, innerEnd));
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
      const reason = scanExecutedSubs(s, i + 3, innerEnd, mode);
      if (reason) return reason;
      i = stop;
      continue;
    }
    if (c === "$" && s.startsWith("$(", i)) {
      const stop = skipBalancedParens(s, i, 2);
      const innerEnd = s[stop - 1] === ")" ? stop - 1 : stop;
      const reason = detectLegacyTool(s.slice(i + 2, innerEnd));
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
      const reason = scanExecutedSubs(s, i + 2, innerEnd, mode);
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
      reason: scanExecutedSubs(s, i + 3, innerEnd, "plain"),
    };
  }
  if (s.startsWith("(", i + 1)) {
    const end = skipBalancedParens(s, i, 2);
    const closeParen = end > 0 && s[end - 1] === ")" ? 1 : 0;
    const inner = s.slice(i + 2, end - closeParen);
    const reason = detectLegacyTool(inner);
    return { next: end, reason };
  }
  if (s.startsWith("{", i + 1)) {
    // Parameter expansion body: `${X:-$(rm)}` executes `rm`.
    const end = skipBalancedBraces(s, i);
    const innerEnd = s[end - 1] === "}" ? end - 1 : end;
    return {
      next: end,
      reason: scanExecutedSubs(s, i + 2, innerEnd, "plain"),
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

function readOperator(s: string, i: number, ioNumber = false): Op | null {
  // An IO number is part of a redirect only at a word boundary (`2>out`),
  // never in the middle of an argument (`file2>out`).
  if (ioNumber) {
    let end = i;
    while (end < s.length && /[0-9]/.test(s[end])) end++;
    if (end > i && (s[end] === "<" || s[end] === ">")) {
      return readOperator(s, end);
    }
  }
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
 * Skip the literal body, scanning unquoted bodies for command substitutions
 * as one region so substitutions can span lines. A body is double-quote-like:
 * it expands `$(...)` and backticks, and both quote characters are literal —
 * bash-verified, `"$(rm)"` and `'$(rm)'` in the body both run. Only a
 * backslash suppresses expansion (`\$(rm)` is literal). Returns the matched
 * rule's reason if a blocked tool is found, undefined otherwise.
 */
function skipHeredocBody(
  s: string,
  i: number,
  delimiter: string,
  indented: boolean,
  quoted: boolean,
): { next: number; reason?: string } {
  let pos = i;
  while (pos <= s.length) {
    const nl = s.indexOf("\n", pos);
    const end = nl === -1 ? s.length : nl;
    let line = s.slice(pos, end);
    if (indented) line = line.replace(/^\t+/, "");
    if (line === delimiter) {
      return {
        next: nl === -1 ? s.length : nl + 1,
        reason: quoted ? undefined : scanExecutedSubs(s, i, pos, "double"),
      };
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return {
    next: s.length,
    reason: quoted ? undefined : scanExecutedSubs(s, i, s.length, "double"),
  };
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

/**
 * Short rg options that consume a value: the rest of the cluster is their
 * value, or — at cluster end — the next word is. `r` is handled separately
 * (and blocked) before this set is consulted.
 */
const RG_SHORT_VALUE_OPTS = new Set([
  "A",
  "B",
  "C",
  "d",
  "E",
  "e",
  "f",
  "g",
  "j",
  "M",
  "m",
  "t",
  "T",
]);

/**
 * Long rg options that consume a value (checked against ripgrep 15.2 --help).
 * Values are skipped before flag inspection, so `--field-match-separator -r` (ripgrep accepts
 * `-r` there as literal output text) is not mistaken for the replace flag.
 */
const RG_LONG_VALUE_OPTS = new Set([
  "--after-context",
  "--before-context",
  "--color",
  "--colors",
  "--context",
  "--context-separator",
  "--dfa-size-limit",
  "--encoding",
  "--engine",
  "--field-context-separator",
  "--field-match-separator",
  "--file",
  "--glob",
  "--generate",
  "--hostname-bin",
  "--hyperlink-format",
  "--iglob",
  "--ignore-file",
  "--max-columns",
  "--max-count",
  "--max-depth",
  "--max-filesize",
  "--path-separator",
  "--pre",
  "--pre-glob",
  "--regex-size-limit",
  "--regexp",
  "--replace",
  "--sort",
  "--sortr",
  "--threads",
  "--type",
  "--type-add",
  "--type-clear",
  "--type-not",
]);

/**
 * Read one whole shell word, shared by command and rg-argument inspection.
 * Only literal text is resolved; an expansion makes the value unknown, but
 * substitutions are still scanned for commands that execute. In particular,
 * letters in `$pattern` must never be mistaken for flags.
 */
function readShellWord(
  s: string,
  i: number,
): {
  word?: string;
  prefix?: string;
  next: number;
  assignment: boolean;
  reason?: string;
} {
  const start = i;
  let word = "";
  let prefix: string | undefined;
  let literal = true;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") break;
    if (readOperator(s, i)) break;
    if (c === "'" || c === '"') {
      const end = readQuote(s, i, c, c === '"');
      const innerEnd = s[end - 1] === c ? end - 1 : end;
      if (c === "'") {
        word += s.slice(i + 1, innerEnd);
      } else {
        const reason = scanExecutedSubs(s, i + 1, innerEnd, "double");
        if (reason) return { next: end, assignment: false, reason };
        for (let j = i + 1; j < innerEnd; j++) {
          const ch = s[j];
          if (ch === "\\" && /[$`"\\\n]/.test(s[j + 1] ?? "")) {
            j++;
            if (s[j] !== "\n") word += s[j];
          } else {
            if (ch === "$" || ch === "`") {
              prefix ??= word;
              literal = false;
            }
            word += ch;
          }
        }
      }
      i = end;
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      // Bash removes this pair before splitting words. It is neither a
      // token nor a separator, including when it appears inside a word.
      if (s[i + 1] !== "\n") word += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = readQuote(s, i, "`", true);
      const innerEnd = s[end - 1] === "`" ? end - 1 : end;
      const reason = detectLegacyTool(s.slice(i + 1, innerEnd));
      if (reason) return { next: end, assignment: false, reason };
      prefix ??= word;
      literal = false;
      i = end;
      continue;
    }
    if (c === "$") {
      const d = readDollar(s, i);
      if (d) {
        if (d.reason)
          return { next: d.next, assignment: false, reason: d.reason };
        prefix ??= word;
        literal = false;
        i = d.next;
        continue;
      }
    }
    word += c;
    i++;
  }
  return {
    word: literal ? word : undefined,
    prefix: prefix ?? word,
    next: i,
    assignment: isAssignmentWord(s.slice(start, i)),
  };
}

/**
 * Array elements are shell words, not commands. Use the same word reader
 * here so comments stay outside words and quotes/expansions stay inside.
 */
function readArrayAssignment(
  s: string,
  start: number,
): { next: number; reason?: string } {
  let i = start + 1;
  let depth = 1;
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i++;
      continue;
    }
    if (s.startsWith("\\\n", i)) {
      i += 2;
      continue;
    }
    if (s[i] === "#") {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    if (s.startsWith("<(", i) || s.startsWith(">(", i)) {
      const end = skipBalancedParens(s, i, 2);
      const innerEnd = s[end - 1] === ")" ? end - 1 : end;
      const reason = detectLegacyTool(s.slice(i + 2, innerEnd));
      if (reason) return { next: end, reason };
      i = end;
      continue;
    }
    if (s[i] === "(") {
      depth++;
      i++;
      continue;
    }
    if (s[i] === ")") {
      if (--depth === 0) return { next: i + 1 };
      i++;
      continue;
    }
    const token = readShellWord(s, i);
    if (token.reason) return token;
    i = token.next > i ? token.next : i + 1;
  }
  return { next: i };
}

/**
 * True when the `rg` invocation starting at `start` uses the replace flag in
 * short form, including clusters (`-rn`, `-rln`, `-nr`). The explicit
 * `--replace` long form stays allowed. Value-taking options are skipped so a
 * pattern/replacement that merely looks like `-r` is not a false hit.
 */
function rgUsesReplaceFlag(s: string, start: number): boolean {
  let i = start;
  let skipValue = false;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (s.startsWith("\\\n", i)) {
      i += 2;
      continue;
    }
    if (c === "\n") break;
    // Unquoted `#` at the start of a word begins a shell comment: bash never
    // passes it (or anything after it) to rg, so `rg -n foo . # avoid -rn`
    // must not be blocked for what its comment merely mentions. Mid-word `#`
    // (`rg foo#bar`) stays inside the word read below, matching bash.
    if (c === "#") break;
    const op = readOperator(s, i, true);
    if (op) {
      if (op.type === "separator") break;
      if (op.type === "heredoc") {
        const delim = readHeredocDelimiter(s, op.next);
        if (!delim) break;
        i = delim.next;
        continue;
      }
      // Redirections may appear among a command's arguments; consume the
      // target (`>out`) and keep looking at the real rg options after it.
      i = op.next;
      while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
      while (s.startsWith("\\\n", i)) {
        i += 2;
        while (s[i] === " " || s[i] === "\t") i++;
      }
      if (i < s.length) i = readShellWord(s, i).next;
      continue;
    }
    const { word, prefix, next } = readShellWord(s, i);
    if (next === i) {
      i++;
      continue;
    }
    i = next;
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (word === "--") break;
    // A known prefix is enough to identify `-r"$replacement"`, without
    // pretending we know the value of `$replacement` or `-$flags`.
    const arg = word ?? prefix ?? "";
    if (arg.startsWith("--")) {
      if (
        word !== undefined &&
        !word.includes("=") &&
        RG_LONG_VALUE_OPTS.has(word)
      )
        skipValue = true;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let k = 1; k < arg.length; k++) {
      const flag = arg[k];
      if (flag === "r") return true;
      if (RG_SHORT_VALUE_OPTS.has(flag)) {
        // The rest of the cluster (or the next word) is this option's value.
        if (word !== undefined && k === word.length - 1) skipValue = true;
        break;
      }
    }
  }
  return false;
}

export function detectLegacyTool(command: string): string | undefined {
  let i = 0;
  let commandPos = true;
  let sudoNext = false;
  let skipNextWord = false;
  let redirectTarget = false;
  const heredocs: {
    delimiter: string;
    indented: boolean;
    quoted: boolean;
  }[] = [];
  // Only case bodies contain commands. The subject and clause patterns are
  // data, although substitutions in either still execute.
  const cases: { phase: "subject" | "in" | "pattern" | "body" }[] = [];

  while (i < command.length) {
    const c = command[i];

    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }

    if (command.startsWith("\\\n", i)) {
      i += 2;
      continue;
    }

    if (c === "#") {
      const nl = command.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }

    if (c === "\n") {
      i++;
      // Bash reads each queued heredoc body after the command line, in
      // declaration order. None of those bodies are command-list text.
      for (const heredoc of heredocs) {
        const result = skipHeredocBody(
          command,
          i,
          heredoc.delimiter,
          heredoc.indented,
          heredoc.quoted,
        );
        if (result.reason) return result.reason;
        i = result.next;
      }
      heredocs.length = 0;
      commandPos = true;
      redirectTarget = false;
      sudoNext = false;
      skipNextWord = false;
      continue;
    }

    const op = readOperator(command, i, true);
    if (op) {
      const caseState = cases.at(-1);
      const clauseEnd =
        command.startsWith(";;", i) || command.startsWith(";&", i);
      const patternEnd = command[i] === ")";
      i = op.next;
      if (caseState?.phase === "pattern") {
        if (patternEnd) {
          caseState.phase = "body";
          commandPos = true;
        }
        continue;
      }
      if (caseState?.phase === "body" && clauseEnd) {
        caseState.phase = "pattern";
      }
      if (op.type === "separator") {
        commandPos = true;
        redirectTarget = false;
        sudoNext = false;
        skipNextWord = false;
      } else if (op.type === "redirect") {
        redirectTarget = true;
      } else if (op.type === "heredoc") {
        const delim = readHeredocDelimiter(command, i);
        if (!delim) break;
        heredocs.push({
          delimiter: delim.delimiter,
          indented: op.indented,
          quoted: delim.quoted,
        });
        i = delim.next;
      }
      continue;
    }

    // Brace group opener: `{` followed by whitespace starts a group; the
    // next word is in command position. Without this, `{ rm; }` evades
    // detection because `{` is read as a word and `rm` lands in argument
    // position.
    if (
      commandPos &&
      c === "{" &&
      (i + 1 >= command.length || /\s/.test(command[i + 1]))
    ) {
      i++;
      commandPos = true;
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
      redirectTarget = false;
      sudoNext = false;
      skipNextWord = false;
      continue;
    }

    const wordStart = i;
    const { word, next, assignment, reason } = readShellWord(command, i);
    if (reason) return reason;
    // Always make progress on incomplete/unsupported syntax.
    if (next === i) {
      i++;
      continue;
    }
    i = next;

    if (redirectTarget) {
      redirectTarget = false;
      continue;
    }

    const caseState = cases.at(-1);
    const unquoted = command.slice(wordStart, next) === word;
    if (caseState && caseState.phase !== "body") {
      if (caseState.phase === "subject") {
        caseState.phase = "in";
      } else if (caseState.phase === "in" && word === "in" && unquoted) {
        caseState.phase = "pattern";
      } else if (caseState.phase === "pattern" && word === "esac" && unquoted) {
        cases.pop();
        commandPos = false;
      }
      continue;
    }
    if (commandPos && word === "esac" && unquoted && caseState) {
      cases.pop();
      commandPos = false;
      continue;
    }

    // An array assignment's parentheses enclose values, not a subshell.
    // Scan only substitutions there, just as for other assignment values.
    // This also covers `declare -a items=(...)` and `local items=(...)`.
    if (assignment && command[i] === "(") {
      const result = readArrayAssignment(command, i);
      if (result.reason) return result.reason;
      i = result.next;
      continue;
    }

    if (commandPos) {
      if (skipNextWord) {
        skipNextWord = false;
        continue;
      }
      if (word === "sudo") {
        sudoNext = true;
        continue;
      }
      if (!sudoNext && word === "case" && unquoted) {
        cases.push({ phase: "subject" });
        continue;
      }
      // Env-var assignment prefix: skip it and stay in command position so
      // the word after it (`rm`, …) is the one checked. Under
      // sudo it likewise keeps sudoNext armed (`sudo FOO=bar rm x`).
      if (assignment) continue;
      if (sudoNext) {
        if (word?.startsWith("-")) {
          // Options that take an argument consume the next word.
          if (SUDO_OPTS_WITH_ARG.has(word)) skipNextWord = true;
          continue;
        }
        sudoNext = false;
      }
      if (word !== undefined) {
        const reason = matchCommandAt(command, word, i);
        if (reason) return reason;
      }
      if (
        word === undefined ||
        !unquoted ||
        !COMMAND_PREFIX_KEYWORDS.has(word)
      ) {
        commandPos = false;
      }
    } else {
      commandPos = false;
    }
  }

  return undefined;
}

export default function preferTools(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return;

    const reason = detectLegacyTool(event.input.command ?? "");
    if (reason) {
      return { block: true, reason };
    }
  });
}
