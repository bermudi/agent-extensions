# agent-pty Manual

Headless PTY orchestration for AI agents. Spawn interactive terminal programs, send keystrokes, capture screen state, and wait for output — all from scripts or agent tool calls.

## Architecture

```
Client (Bun)  ──NDJSON/Unix socket──▶  Daemon (Node.js + node-pty)
                                            │
                                       PTY child (bash/vim/etc)
                                            │
                                       @wterm/core (WASM VT parser)
```

- **Client** — lightweight CLI or API caller. Runs under Bun.
- **Daemon** — long-running process managing PTY sessions. Runs under Node.js (Bun has a [known bug](https://github.com/oven-sh/bun/issues/25822) with `node-pty`).
- **Socket** — `~/.agent-pty/daemon.sock` (Unix domain socket, NDJSON protocol).
- **Auto-start** — the daemon is spawned automatically on first command. No manual setup needed.

## Installation

```bash
cd pi/agent-pty
bun install
cd packages/core && bun run build   # compile daemon to JS
```

Then either run directly or symlink:

```bash
# Direct
./agent-pty <command> [options]

# Symlink into PATH
ln -s $(pwd)/agent-pty ~/.local/bin/agent-pty
```

## Commands

### spawn

Create a new PTY session.

```bash
agent-pty spawn --name <name> [--cwd <dir>] [--cols N] [--rows N] <command> [args...]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--name`, `-n` | *required* | Unique session name |
| `--cwd` | `process.cwd()` | Working directory |
| `--cols` | 80 | Terminal width |
| `--rows` | 24 | Terminal height |

```bash
agent-pty spawn --name editor vim README.md
agent-pty spawn --name shell --cwd /tmp bash
```

Returns: `{ ok, name, pid }`

### type

Send literal text to a session (no newline appended).

```bash
agent-pty type -s <name> <text>
```

| Flag | Default | Description |
|------|---------|-------------|
| `-s`, `--session` | *required* | Session name |

```bash
agent-pty type -s shell 'echo hello'
agent-pty type -s editor ':wq'
```

Returns: `{ ok: true }`

### key

Send a named key or control sequence.

```bash
agent-pty key -s <name> <key>
```

**Available keys:**

| Category | Keys |
|----------|------|
| Basic | `enter`, `return`, `tab`, `escape`, `esc`, `backspace`, `delete`, `space` |
| Arrows | `up`, `down`, `left`, `right` |
| Navigation | `home`, `end`, `pageup`, `pagedown`, `insert` |
| Function | `f1` through `f12` |
| Control | `ctrl-c`, `ctrl-d`, `ctrl-z`, `ctrl-a` through `ctrl-z` |
| Alt | `alt-x`, `alt-f`, etc. (any key after `alt-`) |
| Caret | `^C`, `^D`, etc. |

```bash
agent-pty key -s shell enter
agent-pty key -s shell ctrl-c
agent-pty key -s editor escape
```

Returns: `{ ok: true, sent: "<escape sequence>" }`

### snapshot

Capture the current visible screen.

```bash
agent-pty snapshot -s <name> [-f text|full]
```

| Flag | Default | Description |
|------|---------|-------------|
| `-s`, `--session` | *required* | Session name |
| `-f`, `--format` | `text` | `text` for lines only, `full` includes cell grid |

Returns:

```json
{
  "ok": true,
  "snapshotId": 3,
  "at": "2026-06-03T12:00:00.000Z",
  "size": { "cols": 80, "rows": 24 },
  "cursor": { "row": 5, "col": 12, "visible": true },
  "text": "user@host:~$ echo hello\nhello\nuser@host:~$ █",
  "contentHash": "a3f2b1c8"
}
```

The `contentHash` is a fast hash of the screen text — use it to detect changes without comparing strings.

### scroll

Retrieve scrollback history (lines that scrolled off the visible screen).

```bash
agent-pty scroll -s <name> [--lines N]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--lines` | 0 (all) | Max lines to return |

Returns: `{ ok: true, lines: [...], text: "..." }`

### wait-for

Block until a pattern appears on screen. This is the primary synchronization mechanism.

```bash
agent-pty wait-for -s <name> <pattern> [-r] [-t ms] [--since N]
```

| Flag | Default | Description |
|------|---------|-------------|
| `-s`, `--session` | *required* | Session name |
| `-r` | off | Treat pattern as regex |
| `-t`, `--timeout` | 30000 | Timeout in ms |
| `--since` | — | Only match after this snapshot ID |

```bash
# Wait for shell prompt
agent-pty wait-for -s shell '$ '

# Wait with regex
agent-pty wait-for -s shell 'user@.*:\S+\$' -r

# Send command, then wait for it to appear in output
agent-pty type -s shell 'make build'
agent-pty key -s shell enter
agent-pty wait-for -s shell 'Built successfully' -t 60000
```

Returns: `{ ok: true, matched: true, elapsed: 1523 }` or `{ ok: true, matched: false, timedOut: true }`

**`--since` usage:** When you need to wait for *new* output that doesn't already match, pass the `snapshotId` from a prior snapshot. The daemon skips any matches at or before that ID.

### await-change

Block until the screen content changes from its current state. Useful when you don't know what text to expect.

```bash
agent-pty await-change -s <name> [-t ms] [--settle ms]
```

| Flag | Default | Description |
|------|---------|-------------|
| `-t`, `--timeout` | 30000 | Timeout in ms |
| `--settle` | 200 | Wait for screen to stabilize (ms of inactivity) |

**Pattern:** Call `await-change` *before* triggering the action, then trigger:

```bash
# Start listening FIRST
agent-pty await-change -s shell &
# Then trigger
agent-pty type -s shell 'ls -la'
agent-pty key -s shell enter
# The background wait-for will resolve when the screen changes
```

Returns: `{ ok: true, changed: true, settled: true, contentHash: "...", elapsed: 850 }`

### wait-for-exit

Block until the PTY process exits.

```bash
agent-pty wait-for-exit -s <name> [-t ms]
```

Returns: `{ ok: true, exited: true, exitCode: 0, signal: 0, elapsed: 1500 }`

### kill

Send a signal to a session. Keeps the session record for inspection.

```bash
agent-pty kill -s <name> [--signal SIGTERM]
```

Default signal: `SIGHUP`. Common alternatives: `SIGTERM`, `SIGKILL`, `SIGINT`.

Returns: `{ ok: true, killedAt: "..." }`

### remove

Destroy a session and free its resources. Call after `kill` to clean up.

```bash
agent-pty remove -s <name>
```

### list-sessions

List all active sessions.

```bash
agent-pty list-sessions
```

Returns: `{ ok: true, sessions: [{ name, command, cwd, pid, createdAt, killedAt? }] }`

### stop

Shut down the daemon and all sessions.

```bash
agent-pty stop
```

### daemon

Run the daemon in the foreground (for debugging).

```bash
agent-pty daemon
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_PTY_SOCK` | `~/.agent-pty/daemon.sock` | Custom socket path |
| `AGENT_PTY_DAEMON_CMD` | `node <dist>/daemon.js` | Custom daemon launch command |

## Typical Agent Workflow

```bash
# 1. Spawn a shell
agent-pty spawn --name task bash

# 2. Wait for initial prompt
agent-pty wait-for -s task '$ '

# 3. Run a command
agent-pty type -s task 'cd /project && make test'
agent-pty key -s task enter

# 4. Wait for completion
agent-pty wait-for -s task '$ ' --since <snapshotId> -t 120000

# 5. Capture output
agent-pty snapshot -s task

# 6. Clean up
agent-pty kill -s task
agent-pty remove -s task
```

## MCP Server

For MCP-compatible clients (Claude Code, Devin, Windsurf, etc.):

```json
{
  "mcpServers": {
    "agent-pty": {
      "command": "bun",
      "args": ["run", "packages/mcp-server/src/server.ts"]
    }
  }
}
```

Tools: `agent_pty_spawn`, `agent_pty_type`, `agent_pty_key`, `agent_pty_snapshot`, `agent_pty_scroll`, `agent_pty_wait_for`, `agent_pty_await_change`, `agent_pty_wait_for_exit`, `agent_pty_kill`, `agent_pty_remove`, `agent_pty_list_sessions`.

## All Output is JSON

Every command returns a JSON object with `ok: true/false`. Parse it programmatically:

```bash
result=$(agent-pty snapshot -s task)
echo "$result" | jq -r '.text'
```

## Key Design Decisions

1. **Named sessions** — no auto-generated IDs. You name it, you reference it by name.
2. **Daemon persists** — sessions survive between CLI invocations. The daemon is a single process managing all sessions.
3. **wait-for > sleep** — always use `wait-for` or `await-change` instead of blind sleeps. The daemon watches the PTY in real-time.
4. **Kill then remove** — `kill` sends a signal but keeps the session record. `remove` deletes the record. Two-step so you can inspect exit state.
