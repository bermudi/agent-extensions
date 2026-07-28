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
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") break;
    if (c === "\\" && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (WORD_STOP.includes(c)) break;
    i++;
  }
  return { word: s.slice(start, i), next: i };
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
): { delimiter: string; next: number } | null {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  if (i >= s.length) return null;
  const c = s[i];
  if (c === "'" || c === '"') {
    const end = readQuote(s, i, c, c === '"');
    return { delimiter: s.slice(i + 1, end - 1), next: end };
  }
  const { word, next } = readWord(s, i);
  if (word.length === 0) return null;
  return { delimiter: word, next };
}

function skipHeredocBody(
  s: string,
  i: number,
  delimiter: string,
  indented: boolean,
): number {
  let pos = i;
  while (pos <= s.length) {
    const nl = s.indexOf("\n", pos);
    const end = nl === -1 ? s.length : nl;
    let line = s.slice(pos, end);
    if (indented) line = line.replace(/^\t+/, "");
    if (line === delimiter) {
      return nl === -1 ? s.length : nl + 1;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return s.length;
}

export function detectLegacyTool(command: string): string | undefined {
  let i = 0;
  let commandPos = true;
  let sudoNext = false;
  let redirectTarget = false;
  let heredoc: {
    delimiter: string;
    indented: boolean;
    pending: boolean;
  } | null = null;

  while (i < command.length) {
    if (heredoc && !heredoc.pending) {
      i = skipHeredocBody(command, i, heredoc.delimiter, heredoc.indented);
      heredoc = null;
      commandPos = true;
      redirectTarget = false;
      sudoNext = false;
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
      continue;
    }

    const op = readOperator(command, i);
    if (op) {
      i = op.next;
      if (op.type === "separator") {
        commandPos = true;
        redirectTarget = false;
        sudoNext = false;
      } else if (op.type === "redirect") {
        redirectTarget = true;
        sudoNext = false;
      } else if (op.type === "heredoc") {
        const delim = readHeredocDelimiter(command, i);
        if (!delim) break;
        heredoc = {
          delimiter: delim.delimiter,
          indented: op.indented,
          pending: true,
        };
        i = delim.next;
        commandPos = false;
        redirectTarget = false;
        sudoNext = false;
      }
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
        if (word.startsWith("-")) continue;
        const reason = matchCommand(word);
        if (reason) return reason;
        sudoNext = false;
      } else {
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
