import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
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
  });

  it("allows python/pip/pytest/mypy (block removed 2026-10-24; AGENTS.md instructs uv)", () => {
    // Deliberate removal: hook enforcement of the uv rule — and any
    // "inline-only" python policing — was friction without teeth. The
    // AGENTS.md "Python: uv always" instruction is the mechanism now.
    allowed("python script.py");
    allowed("python3 -c 'print(1)'");
    allowed("./python script.py");
    allowed("pip install x");
    allowed("pip3 install x");
    allowed("pytest");
    allowed("mypy");
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
      "./rm file",
      "rm is blocked — use `trash <path>` instead (moves to the trash can; recoverable beats gone). Do NOT use `trash-rm`: it deletes permanently from the trash can.",
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
    allowed("PYTHONDONTWRITEBYTECODE=1 python x.py");
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
    blocked('"rg" -rn foo .');
    blocked("'rg' -rn foo .");
    blocked('sudo "rg" -rn foo .');
    blocked('FOO=bar "rg" -rn foo .');
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
    allowed('"rg" -n foo .');
    allowed("echo 'rg' -rn foo");
    allowed("'rg'foo -rn");
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

  it("skips separator option values that look like the replace flag", () => {
    // ripgrep 15 takes `-r` here as literal output text, not --replace.
    allowed("rg --field-match-separator '-r' -n foo -");
    allowed("rg --field-context-separator '-r' -n foo -");
    allowed("rg --field-match-separator=-r -n foo -");
    allowed("rg --field-context-separator=-r -n foo -");
    allowed("rg --context-separator '-rn' -n foo -");
  });

  it("stops at a shell comment", () => {
    // Bash never passes the comment to rg, so it must not trip the guard.
    allowed("rg -n foo . # avoid -rn here");
    allowed("rg -n foo . #glued");
    allowed("rg foo#bar");
    allowed("# rg -rn foo");
    // A comment must not blind the scanner to the next line's real command.
    blocked("rg -n foo . # avoid -rn here\nrg -rn bar");
    blocked("rg -rn foo . # comment");
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

  it("finds rg in multiline command lists, pipelines and conditionals", () => {
    blocked("cd src\nrg -rn needle .");
    blocked("cd src && \\\nrg -rn needle .");
    blocked("cd src && \\\n  rg -rn needle .");
    blocked("printf '%s\\n' needle |\n  rg -rn needle");
    blocked("if rg -n first .; then\n  rg -rln second .\nfi");
    blocked("(\n  rg -rn needle .\n)");
  });

  it("joins continued lines before inspecting rg arguments", () => {
    blocked("rg \\\n-rn needle .");
    blocked("rg \\\n  -g '*.ts' \\\n  -rn needle src");
    blocked("rg needle \\\n  -rn .");
    blocked("rg --regexp \\\n  needle \\\n  -rn .");
    allowed("rg \\\n  -n needle .");
    allowed("rg -e \\\n-r file");
    allowed("rg --glob \\\n-r .");
    allowed("rg --replace \\\n  -rn needle .");
    allowed("rg --replace=output \\\n  -n needle .");
  });

  it("recognizes literal flags with expanded values without expanding variables", () => {
    blocked('rg -r"$replacement" needle .');
    blocked('rg -g"$glob" \\\n  -rn needle .');
    allowed('rg -g"$glob" \\\n  -n needle .');
    allowed('rg --replace="$replacement" \\\n  -n needle .');
    allowed('rg "$pattern" "$path"');
    allowed('rg -e "$pattern" -- "$path"');
  });

  it("does not carry rg arguments across real command boundaries", () => {
    allowed("rg -n needle .\nprintf '%s\\n' -rn");
    allowed("rg -n needle . |\n  cat -r");
    allowed("rg -n needle . &&\n  echo -rn");
    allowed("echo rg \\\n  -rn needle .");
    allowed("printf '%s\\n' 'rg \\\n-rn needle .'");
    allowed("rg -n needle . # -rn is not an argument\nprintf '%s\\n' done");
  });

  it("keeps redirections separate from commands and option values", () => {
    blocked(">out rg -rn needle .");
    blocked("2>out rg -rn needle .");
    blocked("rg -e needle >out -rn .");
    allowed(">out echo rg -rn needle");
    allowed("rg -e 2>out -r file");
    allowed("rg --replace >out \\\n  -rn needle .");
  });

  it("keeps inspecting the command line after a heredoc redirect", () => {
    blocked("rg needle <<'EOF' -rn\nneedle\nEOF");
    blocked("<<'EOF' rg -rn needle\nneedle\nEOF");
    allowed("rg --replace <<'EOF' -rn needle\nneedle\nEOF");
    allowed("cat <<'EOF'\nrg \\\n-rn literal\nEOF");
    allowed(
      "cat <<'FIRST' <<'SECOND'\nrg -rn literal\nFIRST\nrg -rn literal\nSECOND",
    );
    blocked(
      "cat <<'FIRST' <<'SECOND'\nliteral\nFIRST\nliteral\nSECOND\nrg -rn needle .",
    );
  });

  it("finds multiline substitutions without treating literal bodies as commands", () => {
    blocked('echo "$(rg -n "needle" -rn file)"');
    blocked("cat <<EOF\n$(rg \\\n-rn needle .)\nEOF");
    blocked("cat <<EOF\n$(\n  rg -rn needle .\n)\nEOF");
    allowed('echo "$(rg -n "needle" file)"');
    allowed("cat <<'EOF'\n$(\n  rg -rn needle .\n)\nEOF");
  });

  it("treats array elements as data while scanning their substitutions", () => {
    allowed('example=("rg" "-rn" needle)\nprintf \'%s\\n\' "${example[@]}"');
    allowed("declare -a example=(rg -rn needle)");
    blocked('example=("$(rg -rn needle .)")');
    blocked("example=(<(rg -rn needle .))");
    allowed('args=(\n  # "$(rg -rn needle .)"\n  --hidden\n)');
    allowed('args=(word#literal "#$(printf text)")');
    blocked(
      "args=(\n  --hidden # don't search ignored paths\n)\nrg -rn needle .",
    );
  });

  it("treats case patterns as data, not case bodies", () => {
    allowed(
      "cmd=rm\ncase \"$cmd\" in\n  'rm') printf '%s\\n' 'use trash instead' ;;\nesac",
    );
    allowed("case \"$cmd\" in\n  'rg'|grep) printf '%s\\n' -rn ;;\nesac");
    blocked('case "$cmd" in\n  search) rg \\\n  -rn needle . ;;\nesac');
    blocked('case "$(rg -rn needle .)" in\n  *) echo done ;;\nesac');
  });
});

describe("prefer-tools real Bash word boundaries", () => {
  // This function only records argv; it does not stand in for ripgrep's
  // option parser. The oracle here is Bash's own parsing of fixed scripts.
  // FD 3 keeps capture separate from stdout, even through 2>/dev/null.
  const capture = "exec 3>&2\nrg() { printf '%s\\0' rg \"$@\" >&3; }\n";
  const fixtures = [
    {
      name: "literal array elements",
      source: 'example=("rg" "-rn" needle)\nprintf \'%s\\n\' "${example[@]}"',
      args: null,
      blocked: false,
    },
    {
      name: "commented-out array substitution",
      source: 'args=(\n  # "$(rg -rn needle .)"\n  --hidden\n)',
      args: null,
      blocked: false,
    },
    {
      name: "array comment does not swallow the next command",
      source:
        "args=(\n  --hidden # don't search ignored paths\n)\nrg -rn needle .",
      args: ["-rn", "needle", "."],
      blocked: true,
    },
    {
      name: "literal case pattern",
      source: "cmd=rg\ncase \"$cmd\" in\n  'rg') printf '%s\\n' -rn ;;\nesac",
      args: null,
      blocked: false,
    },
    {
      name: "command in array substitution",
      source: 'example=("$(rg -rn needle .)")',
      args: ["-rn", "needle", "."],
      blocked: true,
    },
    {
      name: "command in case body",
      source: 'cmd=search\ncase "$cmd" in\n  search) rg -rn needle . ;;\nesac',
      args: ["-rn", "needle", "."],
      blocked: true,
    },
    {
      name: "continued command list",
      source: "true && \\\n  rg -rn needle .",
      args: ["-rn", "needle", "."],
      blocked: true,
    },
    {
      name: "continued argument without indentation",
      source: "rg \\\n-rn needle .",
      args: ["-rn", "needle", "."],
      blocked: true,
    },
    {
      name: "continued option value",
      source: "rg --replace \\\n  -rn needle .",
      args: ["--replace", "-rn", "needle", "."],
      blocked: false,
    },
    {
      name: "short option with an attached expanded value",
      source: 'replacement=n\nrg -r"$replacement" needle .',
      args: ["-rn", "needle", "."],
      blocked: true,
    },
    {
      name: "glob with an attached expanded value",
      source: 'glob="*.ts"\nrg -g"$glob" \\\n  -rn needle .',
      args: ["-g*.ts", "-rn", "needle", "."],
      blocked: true,
    },
    {
      name: "redirect between option and value",
      source: "rg -e 2>/dev/null \\\n  -r file",
      args: ["-e", "-r", "file"],
      blocked: false,
    },
    {
      name: "leading redirect",
      source: "2>/dev/null rg -rn needle .",
      args: ["-rn", "needle", "."],
      blocked: true,
    },
    {
      name: "multiline pipeline",
      source: "printf '%s\\n' needle |\n  rg -rn needle",
      args: ["-rn", "needle"],
      blocked: true,
    },
    {
      name: "heredoc redirect followed by options",
      source: "rg <<'EOF' -rn needle\nrg -rn literal\nEOF",
      args: ["-rn", "needle"],
      blocked: true,
    },
    {
      name: "quoted pattern inside substitution",
      source: 'echo "$(rg -n "needle" -rn file)"',
      args: ["-n", "needle", "-rn", "file"],
      blocked: true,
    },
    {
      name: "multiline substitution inside heredoc",
      source: "cat <<EOF\n$(\n  rg -rn needle .\n)\nEOF",
      args: ["-rn", "needle", "."],
      blocked: true,
    },
  ];

  it.each(fixtures)("$name", ({ source, args, blocked }) => {
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-c", capture + source],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, LC_ALL: "C" },
        timeout: 2000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr.split("\0")).toEqual(
      args === null ? [""] : ["rg", ...args, ""],
    );
    expect(detectLegacyTool(source)).toBe(
      blocked ? RG_REPLACE_REASON : undefined,
    );
  });

  it.skipIf(!Bun.which("rg"))(
    "ripgrep accepts dash-prefixed values, not just flags",
    () => {
      for (const args of [
        ["--regexp", "-r"],
        ["--glob", "-r", "needle"],
        ["--replace", "-rn", "needle"],
        ["--context-separator", "-rn", "needle"],
        ["--field-match-separator", "-r", "needle"],
      ]) {
        const result = spawnSync("rg", ["--no-config", ...args, "-"], {
          encoding: "utf8",
          env: { PATH: process.env.PATH, LC_ALL: "C" },
          input: "-r needle\n",
          timeout: 2000,
        });
        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        // These fixed argv contain no shell metacharacters.
        expect(
          detectLegacyTool(`rg --no-config ${args.join(" ")} -`),
        ).toBeUndefined();
      }
    },
  );
});
