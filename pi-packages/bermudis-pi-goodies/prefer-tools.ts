/**
 * prefer-tools — Enforce modern CLI tooling by blocking the legacy equivalents.
 *
 * A small, quote/heredoc-aware lexer checks each `bash` command for legacy
 * tools in unquoted command position. Quoted strings, heredoc bodies, command
 * substitutions, arithmetic, and plain arguments are ignored.
 *
 *   rm                  -> trash
 *   python/pip/pytest/  -> uv
 *     mypy
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

function matchCommand(name: string): string | undefined {
  const base = name.includes("/")
    ? name.slice(name.lastIndexOf("/") + 1)
    : name;
  for (const rule of RULES) {
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

function readDollar(
  s: string,
  i: number,
): { next: number; reason?: string } | null {
  if (i >= s.length || s[i] !== "$") return null;

  if (s.startsWith("$'", i)) {
    return { next: readQuote(s, i + 1, "'", true) };
  }
  if (s.startsWith("((", i + 1)) {
    return { next: skipBalancedParens(s, i, 3) };
  }
  if (s.startsWith("(", i + 1)) {
    const end = skipBalancedParens(s, i, 2);
    const closeParen = end > 0 && s[end - 1] === ")" ? 1 : 0;
    const inner = s.slice(i + 2, end - closeParen);
    const reason = detectLegacyTool(inner);
    return { next: end, reason };
  }
  if (s.startsWith("{", i + 1)) {
    return { next: skipBalancedBraces(s, i) };
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
 * Scan a single heredoc-body line for command substitutions (`$(...)` and
 * backticks) outside of quotes. In an unquoted heredoc these execute, so a
 * `$(rm)` inside the body is a real bypass. Returns the matched rule's
 * reason if a blocked tool is found, undefined otherwise.
 */
function scanHeredocLineForCommandSubs(line: string): string | undefined {
  let i = 0;
  let quote: '"' | "'" | null = null;
  while (i < line.length) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < line.length) {
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < line.length) {
      i += 2;
      continue;
    }
    if (line.startsWith("$(", i)) {
      const end = skipBalancedParens(line, i, 2);
      const inner = line.slice(i + 2, end - 1);
      const reason = detectLegacyTool(inner);
      if (reason) return reason;
      i = end;
      continue;
    }
    if (c === "`") {
      const end = readQuote(line, i, "`", true);
      const inner = line.slice(i + 1, end - 1);
      const reason = detectLegacyTool(inner);
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
      const reason = scanHeredocLineForCommandSubs(line);
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

export function detectLegacyTool(command: string): string | undefined {
  let i = 0;
  let commandPos = true;
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
      );
      if (result.reason) return result.reason;
      i = result.next;
      heredoc = null;
      commandPos = true;
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

    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i = readQuote(command, i, quote, quote !== "'");
      if (redirectTarget) redirectTarget = false;
      if (sudoNext) sudoNext = false;
      if (commandPos) commandPos = false;
      continue;
    }

    if (c === "$") {
      const d = readDollar(command, i);
      if (d) {
        if (d.reason) return d.reason;
        i = d.next;
        if (redirectTarget) redirectTarget = false;
        if (sudoNext) sudoNext = false;
        if (commandPos) commandPos = false;
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
      commandPos = false;
      continue;
    }

    if (commandPos) {
      if (word === "sudo") {
        sudoNext = true;
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
        const reason = matchCommand(word);
        if (reason) return reason;
        sudoNext = false;
      } else {
        if (skipNextWord) {
          skipNextWord = false;
          continue;
        }
        const reason = matchCommand(word);
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
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return;

    const reason = detectLegacyTool(event.input.command ?? "");
    if (reason) {
      return { block: true, reason };
    }
  });
}
