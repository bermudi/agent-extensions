import { describe, it, expect } from "bun:test";
import {
  detectLegacyTool,
  isRipgrepBlockedModel,
  RG_RULE,
} from "./prefer-tools.ts";

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
      "rm is blocked — use `trash` instead (recoverable beats gone)",
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
      "rm is blocked — use `trash` instead (recoverable beats gone)",
    );
    blocked(
      "/bin/rm -rf /",
      "rm is blocked — use `trash` instead (recoverable beats gone)",
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

  it("allows command arguments and redirect targets", () => {
    allowed("echo rm");
    allowed("echo read/grep/find/ls");
    allowed("cmd > file; echo rm");
  });

  it("blocks command substitutions outside quotes", () => {
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

  // ── Defeat vectors ──────────────────────────────────────────────
  // Each of these was a real bypass of the block before the lexer was
  // hardened. They are the exact patterns the user called out.

  it("blocks backslash-escaped commands (\\rm)", () => {
    blocked(
      "\\rm -rf /",
      "rm is blocked — use `trash` instead (recoverable beats gone)",
    );
    blocked(
      "\\python script.py",
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
    );
  });

  it("blocks commands inside brace groups ({ rm; })", () => {
    blocked(
      "{ rm -rf /; }",
      "rm is blocked — use `trash` instead (recoverable beats gone)",
    );
    blocked(
      "{ rm file; }",
      "rm is blocked — use `trash` instead (recoverable beats gone)",
    );
  });

  it("blocks sudo with option arguments (sudo -u root rm)", () => {
    blocked(
      "sudo -u root rm -rf /",
      "rm is blocked — use `trash` instead (recoverable beats gone)",
    );
    blocked(
      "sudo -g wheel rm file",
      "rm is blocked — use `trash` instead (recoverable beats gone)",
    );
    blocked(
      "sudo -u root -g wheel rm file",
      "rm is blocked — use `trash` instead (recoverable beats gone)",
    );
  });

  it("blocks command substitutions in unquoted heredoc bodies", () => {
    blocked(
      "cat <<EOF\n$(rm -rf /)\nEOF",
      "rm is blocked — use `trash` instead (recoverable beats gone)",
    );
    blocked(
      "cat <<EOF\n$(python evil.py)\nEOF",
      "bare python/pip/pytest/mypy are blocked — use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)",
    );
    blocked(
      "cat <<EOF\n`rm file`\nEOF",
      "rm is blocked — use `trash` instead (recoverable beats gone)",
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
      "rm is blocked — use `trash` instead (recoverable beats gone)",
    );
  });

  it("allows $(rm) inside single quotes within unquoted heredoc bodies", () => {
    // In an unquoted heredoc, single quotes still quote — $(rm) inside
    // single quotes does NOT execute.
    allowed("cat <<EOF\necho '$(rm file)'\nEOF");
  });
});

describe("isRipgrepBlockedModel", () => {
  it("matches glm-5 model ids", () => {
    expect(isRipgrepBlockedModel("glm-5")).toBe(true);
    expect(isRipgrepBlockedModel("glm-5.5")).toBe(true);
    expect(isRipgrepBlockedModel("glm-5-turbo")).toBe(true);
    expect(isRipgrepBlockedModel("glm-5:free")).toBe(true);
    expect(isRipgrepBlockedModel("kilo/glm-5")).toBe(true);
    expect(isRipgrepBlockedModel("GLM-5")).toBe(true);
  });

  it("does not match other models", () => {
    expect(isRipgrepBlockedModel("glm-4.6")).toBe(false);
    expect(isRipgrepBlockedModel("claude-opus-4-5")).toBe(false);
    // Digit continuation: glm-50 is not glm-5.
    expect(isRipgrepBlockedModel("glm-50")).toBe(false);
    expect(isRipgrepBlockedModel("glm-500")).toBe(false);
    // Meta's XGLM family embeds "glm-5" without a boundary (xglm-564M).
    expect(isRipgrepBlockedModel("xglm-564M")).toBe(false);
    expect(isRipgrepBlockedModel(undefined)).toBe(false);
  });
});

describe("detectLegacyTool with rg rule (glm-5 models)", () => {
  const blocked = (cmd: string, expected: string) => {
    expect(detectLegacyTool(cmd, [RG_RULE])).toBe(expected);
  };
  const allowed = (cmd: string) => {
    expect(detectLegacyTool(cmd, [RG_RULE])).toBeUndefined();
  };
  const reason = RG_RULE.reason;

  it("blocks rg in command position", () => {
    blocked("rg -n foo .", reason);
    blocked("rg pattern file.txt", reason);
    blocked("sudo rg -n foo", reason);
    blocked("cat x | rg foo", reason);
    blocked("rg foo && echo done", reason);
    blocked("\\rg foo", reason);
    blocked("{ rg foo; }", reason);
  });

  it("blocks rg inside command substitutions and unquoted heredocs", () => {
    blocked("echo $(rg foo)", reason);
    blocked("cat <<EOF\n$(rg foo)\nEOF", reason);
    blocked("cat <<EOF\n`rg foo`\nEOF", reason);
  });

  it("allows grep and non-command occurrences", () => {
    allowed("grep -rn foo .");
    allowed("grep -rn --include='*.ts' foo src");
    allowed("echo rg");
    allowed("echo 'rg -n foo'");
    allowed("cat <<'EOF'\nrg foo\nEOF");
    allowed("git grep -n foo");
  });

  it("is inert without the rule (non-glm models)", () => {
    expect(detectLegacyTool("rg -n foo .")).toBeUndefined();
  });
});
