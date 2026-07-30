# pi-critique

Open [Critique](https://github.com/remorses/critique) from Pi without making
Critique part of Pi's Node.js process. The extension temporarily releases the
terminal, runs Critique with Bun, and restores Pi when Critique exits.

## Usage

```text
/critique
/critique --staged
/critique main HEAD
/critique --commit HEAD~1
/critique --filter "src/**/*.ts"
/critique --watch
/critique review
/critique review --staged
```

`/critique review` launches [pi-acp](https://github.com/svkozak/pi-acp), so
Critique's AI review runs through Pi. Pass `--agent opencode`, `--agent claude`,
or `--agent-command <executable>` to select another ACP agent explicitly.

Press `q` or `Esc` to leave Critique and return to Pi.

The command accepts Critique CLI arguments. It is intentionally only a slash
command; no agent-callable tool uploads repository contents.

## Development

```bash
bun install
bun run typecheck
bun run test
pi -e ./index.ts
```

Critique requires Bun. This package pins the published Critique release used by
the extension and carries a temporary package patch for the generic ACP launcher.
The matching upstream-ready implementation lives in the Critique checkout and
should replace the patch after it is released.

`pi-acp` does not currently implement ACP session resume. Fresh Pi-backed reviews
work, but resuming an interrupted Pi-backed review falls back to its saved partial
output.

## Security

Pi-backed review starts a normal Pi RPC agent in the repository. Its enabled tools
can execute commands and modify files, and Critique's review flow does not provide
a read-only sandbox. Treat reviewed diffs as untrusted prompt input and run reviews
in a disposable worktree or sandbox when that risk matters.
