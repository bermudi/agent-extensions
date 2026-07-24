import { describe, it, expect } from "bun:test";
import { detectLegacyTool } from "./prefer-tools.ts";

describe("detectLegacyTool", () => {
  const blocked = (cmd: string, expected: string) => {
    expect(detectLegacyTool(cmd)).toBe(expected);
  };
  const allowed = (cmd: string) => {
    expect(detectLegacyTool(cmd)).toBeUndefined();
  };

  it("blocks direct legacy commands", () => {
    blocked("grep foo", "grep is blocked — use `rg` (ripgrep) instead");
    blocked("egrep foo", "grep is blocked — use `rg` (ripgrep) instead");
    blocked("Egrep foo", "grep is blocked — use `rg` (ripgrep) instead");
    blocked("fgrep foo", "grep is blocked — use `rg` (ripgrep) instead");
    blocked(
      "rm -rf /",
      "rm is blocked — use `trash` instead (recoverable beats gone)",
    );
    blocked("find .", "find is blocked — use `fd` instead");
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

  it("blocks legacy commands in pipelines, lists, and subshells", () => {
    blocked(
      "cat file | grep foo",
      "grep is blocked — use `rg` (ripgrep) instead",
    );
    blocked(
      "cat file && grep foo",
      "grep is blocked — use `rg` (ripgrep) instead",
    );
    blocked(
      "cat file || grep foo",
      "grep is blocked — use `rg` (ripgrep) instead",
    );
    blocked(
      "cat file; grep foo",
      "grep is blocked — use `rg` (ripgrep) instead",
    );
    blocked("(grep foo)", "grep is blocked — use `rg` (ripgrep) instead");
    blocked(
      "if grep foo; then echo bar; fi",
      "grep is blocked — use `rg` (ripgrep) instead",
    );
    blocked(
      "while grep foo; do echo bar; done",
      "grep is blocked — use `rg` (ripgrep) instead",
    );
  });

  it("blocks sudo and absolute/relative paths", () => {
    blocked(
      "sudo rm -rf /",
      "rm is blocked — use `trash` instead (recoverable beats gone)",
    );
    blocked("sudo grep foo", "grep is blocked — use `rg` (ripgrep) instead");
    blocked("sudo -E grep foo", "grep is blocked — use `rg` (ripgrep) instead");
    blocked(
      "/usr/bin/grep foo",
      "grep is blocked — use `rg` (ripgrep) instead",
    );
    blocked(
      "/bin/rm -rf /",
      "rm is blocked — use `trash` instead (recoverable beats gone)",
    );
    blocked(
      "./python script.py",
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
    );
    blocked("bin/grep foo", "grep is blocked — use `rg` (ripgrep) instead");
  });

  it("allows quoted or heredoc occurrences of legacy tool text", () => {
    allowed("rg -n 'a|grep|b'");
    allowed('rg -n "a|grep|b"');
    allowed('echo "grep is blocked"');
    allowed("echo 'grep is blocked'");
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
    allowed("fd");
    allowed("rg");
  });

  it("allows heredoc bodies", () => {
    allowed("cat <<EOF\nread/grep/find/ls\nEOF");
    allowed("cat <<'EOF'\ngrep foo\nEOF");
    allowed('cat <<-"EOF"\n\tgrep foo\n\tEOF');
    allowed("cat <<EOF | wc\ngrep foo\nEOF");
  });

  it("allows multiline quoted commit messages", () => {
    allowed('git commit -m "line1\ngrep foo\nline3"');
    allowed("git commit -m 'line1\ngrep foo\nline3'");
  });

  it("allows command arguments and redirect targets", () => {
    allowed("echo rm");
    allowed("echo ./grep");
    allowed("echo read/grep/find/ls");
    allowed("cmd > grep");
    allowed("cmd > file; echo grep");
    allowed("cmd 2>&1 | rg");
  });

  it("blocks command substitutions outside quotes", () => {
    blocked("echo $(grep foo)", "grep is blocked — use `rg` (ripgrep) instead");
    blocked(
      "echo $(sudo rm -rf /)",
      "rm is blocked — use `trash` instead (recoverable beats gone)",
    );
  });

  it("allows arithmetic and variable expansion", () => {
    allowed("echo $((1+2))");
    allowed("echo $VAR");
    allowed("echo ${VAR}");
  });
});
