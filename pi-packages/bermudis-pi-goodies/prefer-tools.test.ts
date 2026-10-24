import { describe, it, expect } from "bun:test";
import { detectLegacyTool, RG_REPLACE_REASON } from "./prefer-tools.ts";

describe("detectLegacyTool", () => {
  const blocked = (cmd: string, expected: string) => {
    expect(detectLegacyTool(cmd)).toBe(expected);
  };
  const allowed = (cmd: string) => {
    expect(detectLegacyTool(cmd)).toBeUndefined();
  };

  it("blocks direct legacy commands", () => {
    blocked(
      "rm -rf /",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "python script.py",
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
    );
    blocked(
      "python3 script.py",
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
    );
    blocked(
      "pip install x",
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
    );
    blocked(
      "pip3 install x",
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
    );
    blocked(
      "pytest",
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
    );
    blocked(
      "mypy",
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
    );
  });

  it("blocks sudo and absolute/relative paths", () => {
    blocked(
      "sudo rm -rf /",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "/bin/rm -rf /",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "./python script.py",
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
    );
  });

  it("allows quoted or heredoc occurrences of legacy tool text", () => {
    allowed("echo 'grep is blocked'");
    allowed("echo 'find is blocked'");
    allowed("echo read/grep/find/ls");
    allowed("echo rm is not allowed");
  });

  it("allows git grep and uv-wrapped tools", () => {
    allowed("git grep foo");
    allowed("git grep -n foo");
    allowed("uv run python script.py");
    allowed("uv run pytest");
    allowed("uv run mypy");
    allowed("trash file");
    allowed("trash notes.md");
    allowed("trash-put notes.md");
    allowed("trash-list");
    allowed("trash-restore");
  });

  it("blocks trash-rm and trash-empty (permanent deletes from the trash can)", () => {
    const TRASH_RM =
      "trash-rm and trash-empty are blocked — they delete permanently from the trash can. Use `trash <path>` to move files to the trash (recoverable).";
    blocked("trash-rm foo", TRASH_RM);
    blocked("trash-rm '*.o'", TRASH_RM);
    blocked("/usr/bin/trash-rm foo", TRASH_RM);
    blocked("trash-empty", TRASH_RM);
    blocked("trash a && trash-rm a", TRASH_RM);
  });

  it("allows heredoc bodies", () => {
    allowed("cat <<EOF\nrm file\nEOF");
    allowed("cat <<'EOF'\nrm file\nEOF");
    allowed('cat <<-"EOF"\n\trm file\n\tEOF');
    allowed("cat <<EOF | wc\nrm file\nEOF");
  });

  it("allows multiline quoted commit messages", () => {
    allowed('git commit -m "line1\ngrep foo\nline3"');
    allowed("git commit -m 'line1\ngrep foo\nline3'");
  });

  it("blocks env-var assignment prefixes (FOO=bar rm x)", () => {
    blocked(
      "FOO=bar rm x",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "PYTHONDONTWRITEBYTECODE=1 python x.py",
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
    );
    blocked(
      "A=1 B=2 rm file",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      'FOO="quoted value" rm file',
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "FOO='single quoted' rm file",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "FOO=$BASE rm file",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "FOO=$(echo hi) rm file",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "FOO+=bar rm file",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    // Assignment + leading redirect still runs the command.
    blocked(
      "FOO=1 > /dev/null rm file",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "FOO=1 > $OUT rm file",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "sudo FOO=bar rm file",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "FOO=bar\nrm file",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
  });

  it("allows env assignments without a blocked command", () => {
    allowed("FOO=bar");
    allowed("FOO=bar echo hi");
    // The value is the string "rm", not a command.
    allowed("FOO=rm");
    allowed("FOO=rm echo hi");
    // `rm` here is an argument to echo.
    allowed("FOO=bar echo rm");
    allowed("echo FOO=bar");
    allowed("FOO=bar uv run python script.py");
  });

  it("allows command arguments and redirect targets", () => {
    allowed("echo rm");
    allowed("echo read/grep/find/ls");
    allowed("cmd > file; echo rm");
  });

  it("blocks command substitutions outside quotes", () => {
    blocked(
      "echo $(sudo rm -rf /)",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
  });

  it("allows arithmetic and variable expansion", () => {
    allowed("echo $((1+2))");
    allowed("echo $VAR");
    allowed("echo ${VAR}");
  });

  // ── Defeat vectors ──────────────────────────────────────────────
  // Each of these was a real bypass of the block before the lexer was
  // hardened. They are the exact patterns the user called out.

  it("blocks backslash-escaped commands (\\rm)", () => {
    blocked(
      "\\rm -rf /",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "\\python script.py",
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
    );
  });

  it("blocks commands inside brace groups ({ rm; })", () => {
    blocked(
      "{ rm -rf /; }",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "{ rm file; }",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
  });

  it("blocks sudo with option arguments (sudo -u root rm)", () => {
    blocked(
      "sudo -u root rm -rf /",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "sudo -g wheel rm file",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "sudo -u root -g wheel rm file",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
  });

  it("blocks command substitutions in unquoted heredoc bodies", () => {
    blocked(
      "cat <<EOF\n$(rm -rf /)\nEOF",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      "cat <<EOF\n$(python evil.py)\nEOF",
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
    );
    blocked(
      "cat <<EOF\n`rm file`\nEOF",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
  });

  it("still allows quoted heredoc bodies with $(rm) (no execution)", () => {
    allowed("cat <<'EOF'\n$(rm file)\nEOF");
    allowed('cat <<"EOF"\n$(rm file)\nEOF');
  });

  it("allows sudo running non-blocked commands with option arguments", () => {
    allowed("sudo -u root echo hello");
    allowed("sudo -g wheel ls -la");
    allowed("sudo -u root -g wheel cat file");
  });

  it("allows brace groups with non-blocked commands", () => {
    allowed("{ echo hello; }");
    allowed("{ ls -la; }");
  });

  it("allows backslash-escaped non-blocked commands", () => {
    allowed("\\echo hello");
    allowed("\\ls -la");
  });

  it("blocks nested command substitutions in unquoted heredocs", () => {
    blocked(
      "cat <<EOF\n$(echo $(rm file))\nEOF",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
  });

  it("blocks $(rm) inside single quotes within unquoted heredoc bodies", () => {
    // bash-verified: an unquoted heredoc body is double-quote-like — single
    // quotes are literal characters there, so this substitution RUNS (a
    // marker-file probe confirmed execution). The historical "single quotes
    // still quote" model was a false negative. Real suppression requires a
    // quoted delimiter (<<'EOF'), which stays allowed below.
    blocked(
      "cat <<EOF\necho '$(rm file)'\nEOF",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    blocked(
      'cat <<EOF\necho "$(rm file)"\nEOF',
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
  });

  // ── Executed substitutions: quotes do not hide commands ─────────
  // Every expectation below was verified against real bash with a
  // marker-file probe (the command runs ⇔ the marker appears) — see the
  // scenarios in each comment.

  it("blocks double-quoted command substitutions and backticks", () => {
    // bash: echo "$(touch m)" and echo "`touch m`" both create the marker.
    const RM =
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.";
    blocked('echo "$(rm x)"', RM);
    blocked('echo "`rm x`"', RM);
    blocked("echo `rm x`", RM);
    blocked('echo "$(echo "$(rm x)")"', RM);
    // Backslash escapes: only the escaped dollar is inert; a doubled
    // backslash or a backslash before an unrelated char still executes.
    allowed('echo "\\$(rm x)"');
    blocked('echo "\\\\$(rm x)"', RM);
    blocked('echo "\\q$(rm x)"', RM);
  });

  it("blocks substitutions inside arithmetic and parameter expansions", () => {
    const RM =
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.";
    // bash: x=$(( $(touch m) + 1 )) runs touch; $(( 1 + 2 )) does not.
    blocked("x=$(( $(rm x) + 1 ))", RM);
    allowed("x=$(( 1 + 2 ))");
    // bash: ${X:-$(touch m)} runs touch.
    blocked('echo "${X:-$(rm x)}"', RM);
    blocked("echo ${X:-$(rm x)}", RM);
    // bash-verified: quotes in an unquoted expansion's word still quote
    // (literal), but inside double quotes they are literal characters and
    // the substitution runs — the scanner must inherit the quoting mode.
    allowed("echo ${X:-'$(rm x)'}");
    blocked("echo \"${X:-'$(rm x)'}\"", RM);
    // bash-verified: $"…" (locale) expands substitutions; $'…' (ANSI-C)
    // does not.
    blocked('echo $"$(rm x)"', RM);
    allowed("echo $'$(rm x)'");
  });

  it("keeps command position across assignment value expansions", () => {
    // bash: FOO=$HOME rm x runs rm with FOO set — the expansion in the
    // assignment value must not end command position.
    blocked(
      "FOO=$HOME rm x",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
    );
    allowed("FOO=$HOME echo x");
  });
});

describe("detectLegacyTool rg replace guard", () => {
  const blocked = (cmd: string) => {
    expect(detectLegacyTool(cmd)).toBe(RG_REPLACE_REASON);
  };
  const allowed = (cmd: string) => {
    expect(detectLegacyTool(cmd)).toBeUndefined();
  };

  it("blocks -r and short-option clusters containing it", () => {
    blocked("rg -r foo .");
    blocked("rg -rn foo .");
    blocked("rg -rln foo .");
    blocked("rg -nr foo .");
    blocked("rg -A3 -r foo .");
    blocked("rg -g '*.ts' -rn foo .");
    blocked('rg "-r" foo .');
    blocked("rg '-rn' foo .");
    blocked("./rg -rn foo .");
    blocked("sudo rg -rn foo .");
    blocked("FOO=bar rg -rn foo .");
    blocked("cat x | rg -rn foo");
    blocked("rg -rn foo && echo done");
    blocked("\\rg -rn foo");
    blocked("{ rg -rn foo; }");
    blocked("rg foo >out -rn bar");
    blocked("rg foo 2>&1 -rn bar");
  });

  it("blocks -r inside command substitutions and unquoted heredocs", () => {
    blocked("echo $(rg -rn foo)");
    blocked('echo "$(rg -rn foo)"');
    blocked("echo `rg -rn foo`");
    blocked("cat <<EOF\n$(rg -rn foo)\nEOF");
    blocked("cat <<EOF\n`rg -rn foo`\nEOF");
  });

  it("allows rg without the replace flag", () => {
    allowed("rg -n foo .");
    allowed("rg pattern file.txt");
    allowed("rg -U -n foo .");
    allowed("rg -g '*.ts' -n foo src");
    allowed("rg -e -r file");
    allowed("rg -g -r .");
    allowed("rg -n 'foo-r' .");
    allowed("rg -- -r");
  });

  it("allows the explicit --replace long form", () => {
    allowed("rg --replace foo .");
    allowed("rg --replace=foo pattern .");
    allowed("rg --replace -rn pattern .");
    allowed("rg --glob=-r -n foo .");
  });

  it("allows non-command occurrences of rg", () => {
    allowed("echo rg");
    allowed("echo rg -rn foo");
    allowed("echo 'rg -rn foo'");
    allowed("cat <<'EOF'\nrg -rn foo\nEOF");
    allowed("grep -rn foo .");
    allowed("grep -rn --include='*.ts' foo src");
    allowed("git grep -n foo");
  });
});
