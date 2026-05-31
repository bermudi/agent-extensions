---
name: agent-pty
description: Drive interactive terminal programs (REPLs, TUIs, curses apps, interactive CLI wizards) through a headless PTY. Use when a task needs to send input, read screen state, or wait for visual changes in a terminal session. Prefer pi-processes for background jobs that only need log tails.
---

# agent-pty

Headless PTY orchestration for AI agents. Spawn interactive programs, type input, capture structured screen snapshots, and wait for on-screen changes.

## When to use agent-pty

| Use agent-pty | Use pi-processes instead |
|---|---|
| vim, less, nano, tmux, top | dev servers, build watchers |
| REPLs (python, node, psql) | `npm run test --watch` |
| Interactive CLI wizards, curses apps | `tail -f logfile` |
| Any program that needs keystrokes and screen reading | Background jobs with log tails |

## Commands

All commands auto-start the Node.js daemon on first use unless `AGENT_PTY_DAEMON_CMD` overrides it.

You can use the root-level `./agent-pty` wrapper instead of `bun packages/cli/src/index.ts`.

**spawn** — create a named PTY session
```bash
bun packages/cli/src/index.ts spawn --name <n> [--cwd <dir>] [--cols N] [--rows N] <command> [args...]
```
Required: `--name`, `<command>`. Returns `{ok, name, pid}`. Duplicate names are rejected.

**type** — send literal text
```bash
bun packages/cli/src/index.ts type -s <name> <text...>
```

**key** — send a named key or control sequence
```bash
bun packages/cli/src/index.ts key -s <name> <key>
```
Keys: `enter`, `tab`, `escape`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `ctrl-c`, `ctrl-d`, `alt-x`, caret notation (`^C`). Returns `{ok, sent}`.

**snapshot** — capture the current visible screen
```bash
bun packages/cli/src/index.ts snapshot -s <name> [-f full|text]
```
Returns `{snapshotId, at, size, cursor, text, contentHash}`; `grid` included only with `-f full`.

**scroll** — retrieve scrollback history (lines that scrolled off the visible screen)
```bash
bun packages/cli/src/index.ts scroll -s <name> [--lines N]
```
Returns `{lines, text}`. `lines` is an array of scrollback strings; `text` is the joined output. Use `--lines` to limit the result (default: all scrollback).

**wait-for** — block until screen text matches a pattern
```bash
bun packages/cli/src/index.ts wait-for -s <name> <pattern> [-r] [-t <ms>] [--since <snapshotId>]
```
Default: literal match (auto-escapes regex chars). Use `-r` for regex. Returns `{matched, elapsed}` or `{matched: false, timedOut: true}`. If the pattern is already visible, returns instantly with `elapsed: 0`.

Use `--since <snapshotId>` to skip the immediate check and only match on data arriving after the given snapshot ID. This prevents the "temporal footgun" where the pattern was already on screen before you called `wait-for`.

**await-change** — block until the screen changes from its current state
```bash
bun packages/cli/src/index.ts await-change -s <name> [-t <ms>] [--settle <ms>]
```
Captures baseline **at call time**. Start this *before* triggering the action. `settle` (default 200ms) resets on every hash change; use `--settle 0` to resolve immediately on first change. Returns `{changed, settled, contentHash, elapsed}`.

**kill** — terminate a session
```bash
bun packages/cli/src/index.ts kill -s <name> [--signal <sig>]
```
Marks the session as killed but keeps the record for forensic inspection (snapshot still works). Returns `{ok, killedAt}`.

**remove** — permanently delete a session record
```bash
bun packages/cli/src/index.ts remove -s <name>
```
Removes the session from the daemon. Use after `kill` when you no longer need the forensic state.

**list-sessions** — list sessions (including killed ones)
```bash
bun packages/cli/src/index.ts list-sessions
```
Returns array of `{name, command, cwd, pid, createdAt, killedAt?}`. Killed sessions include `killedAt`.

**stop** — shut down the daemon
```bash
bun packages/cli/src/index.ts stop
```

## Typical flow

1. **Spawn** with a stable name.
2. **Wait for a prompt** (or `await-change` after initial spawn settles).
3. **Type** input and/or **key** sequences.
4. **wait-for** expected output, **await-change** after triggering actions, or **snapshot** to inspect state.
5. **kill** when done.

## Screen vs scrollback

`snapshot` captures the **currently visible terminal grid** (rows x cols). `scroll` retrieves lines that have scrolled off the visible screen. VT escape sequences are stripped by `@wterm/core` in both cases. The `text` field is the rendered content. To track historical output, use `scroll` for past lines or collect multiple snapshots over time.

## wait-for vs await-change

- **wait-for**: use when you know what text should appear (e.g., prompt, "Done", error message). Matches on the visible screen. If the pattern is already there, returns instantly.
- **await-change**: use when you triggered an action and need to know the screen updated, but you do not know the exact resulting text. Must be started *before* the trigger. Respects settle time for stability.

## Key sequences

Named keys and control combos are resolved through `keys.ts`:

| Input | Sent |
|---|---|
| `enter`, `return` | `\r` |
| `tab` | `\t` |
| `escape`, `esc` | `\x1b` |
| `backspace` | `\x7f` |
| `up` / `down` / `left` / `right` | ANSI arrows |
| `ctrl-c`, `ctrl-d`, ... | Control chars |
| `alt-x` | `\x1b` + resolved key |
| `^C`, `^D` | Caret notation |
| Single character | literal |

## Gotchas

- **Bun client, Node daemon.** The CLI client runs under Bun; the daemon runs under Node.js because `node-pty` + Bun kills PTY children with SIGHUP (`oven-sh/bun#25822`). Do not attempt to run the daemon under Bun.
- **Daemon auto-start.** `ensureDaemon()` spawns the compiled daemon if the socket is unreachable. Build the daemon first: `cd packages/core && bun run build`.
- **await-change order sensitivity.** Start `await-change` *before* the action that changes the screen. If you start it after, the new state becomes the baseline and it may time out without detecting a change.
- **Settle behavior.** The settle timer resets on every screen hash change. Rapid-fire output extends the wait. Use `--settle 0` for immediate resolution on first change.
- **`wait-for` temporal footgun.** If the pattern is already on screen, `wait-for` returns instantly. Use `--since <snapshotId>` (from a prior `snapshot`) to skip the immediate check and only match on new data. This is essential when you snapshot, trigger an action, and then wait for a result that might have been present in the baseline snapshot.
- **`wait-for` on short strings can match banner text.** Python version banners contain digits; shell prompts contain `$`. After typing input, prefer `await-change` to detect the screen updating, or use a specific multi-word pattern.
- **Regex vs literal.** `wait-for` defaults to literal: special regex characters are auto-escaped. Use `-r` only when you need pattern matching.
- **contentHash is djb2.** Adequate for change detection, but collision-prone. Do not use it for security, persistence, or content addressing.
- **No PID file with `AGENT_PTY_SOCK`.** When the socket path is overridden via environment, the daemon skips PID file creation.

## Example patterns

**Drive a Python REPL:**
```bash
./agent-pty spawn --name py python3
./agent-pty wait-for -s py ">>>"
./agent-pty type -s py 'print("agent-pty ok")'
./agent-pty key -s py enter
./agent-pty wait-for -s py "agent-pty ok"
./agent-pty snapshot -s py
./agent-pty kill -s py
./agent-pty remove -s py
```

**Wait for a prompt after a command:**
```bash
./agent-pty type -s shell "git status"
./agent-pty key -s shell enter
./agent-pty wait-for -s shell "$" -r
```

**Navigate a TUI and detect change:**
```bash
# Start await-change BEFORE sending the key
./agent-pty await-change -s vim -t 5000 --settle 200 &
./agent-pty key -s vim down
# Wait for the backgrounded await-change to return
```
