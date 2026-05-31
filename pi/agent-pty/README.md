# agent-pty

Headless PTY orchestration tool for AI agents. TypeScript/Bun client + Node.js daemon.

## Stack

- **Client**: Bun + TypeScript
- **Daemon**: Node.js + `node-pty` + `@wterm/core` (WASM VT parser, pre-compiled to JS)
- **Protocol**: NDJSON over Unix domain socket

## Why Node.js for the daemon?

`node-pty` has a critical compatibility bug with Bun: spawned PTY children immediately receive SIGHUP and exit. The same `node-pty` code works correctly under Node.js. The client (lightweight CLI) runs under Bun; the daemon (long-running PTY manager) runs under Node.js via `tsx`.

**Root cause:** Bun's `tty.ReadStream` auto-closes file descriptors that `node-pty` owns. When the stream is destroyed (Bun treats EAGAIN as fatal on non-blocking PTY fds), the PTY master fd closes. The kernel sees the controlling terminal vanish and sends SIGHUP to the child. Reproduced in a clean Docker `oven/bun:1.3.14` container — not system-specific.

**Tracking:** [oven-sh/bun#25822](https://github.com/oven-sh/bun/issues/25822) (open). Proposed fix in [PR #25994](https://github.com/oven-sh/bun/pull/25994) (not yet merged). Migrate daemon to pure Bun once resolved.

## Workspace layout

```
packages/
  core/          # Shared daemon, session engine, Unix-socket client
  cli/           # CLI frontend (`agent-pty` bin)
  pi-extension/  # Pi extension frontend (tools + commands)
  mcp-server/    # MCP server for Devin CLI, Claude Code, Windsurf, etc.
```

Both frontends talk to the same daemon via `@agent-pty/core`.

## Commands

```bash
# Auto-starts daemon on first use
bun packages/cli/src/index.ts spawn --name <n> [--cwd <dir>] <command> [args...]
bun packages/cli/src/index.ts type -s <name> <text>
bun packages/cli/src/index.ts key -s <name> <key>
bun packages/cli/src/index.ts snapshot -s <name> [-f full|text]
bun packages/cli/src/index.ts scroll -s <name> [--lines N]
bun packages/cli/src/index.ts wait-for -s <name> <pattern> [-r] [-t <ms>] [--since <snapshotId>]
bun packages/cli/src/index.ts await-change -s <name> [-t <ms>] [--settle <ms>]
bun packages/cli/src/index.ts wait-for-exit -s <name> [-t <ms>]
bun packages/cli/src/index.ts kill -s <name> [--signal <sig>]
bun packages/cli/src/index.ts remove -s <name>
bun packages/cli/src/index.ts list-sessions
bun packages/cli/src/index.ts stop          # shutdown daemon

# Or use the root-level wrapper (works from anywhere if invoked by absolute path)
./agent-pty spawn --name <n> bash
```

## Example

```bash
./agent-pty spawn --name demo bash
./agent-pty type -s demo 'echo hello'
./agent-pty key -s demo enter
sleep 0.3
./agent-pty snapshot -s demo
./agent-pty kill -s demo
./agent-pty remove -s demo
```

## Key map

Named keys: `enter`, `tab`, `escape`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `ctrl-c`, `ctrl-d`, etc.

## Architecture

```
Client (Bun)  --NDJSON/Unix sock-->  Daemon (Node.js + tsx)
                                           |
                                     node-pty forkpty
                                           |
                                     @wterm/core WASM bridge
                                           |
                                     PTY child (bash/vim/etc)
```

## MCP server

Use agent-pty from any MCP-compatible client (Devin CLI, Claude Code, Windsurf, etc.):

```json
// .devin/config.json
{
  "mcpServers": {
    "agent-pty": {
      "command": "bun",
      "args": ["run", "packages/mcp-server/src/server.ts"]
    }
  }
}
```

The MCP server exposes one tool per daemon command (`agent_pty_spawn`, `agent_pty_type`, `agent_pty_key`, `agent_pty_snapshot`, `agent_pty_scroll`, `agent_pty_wait_for`, `agent_pty_await_change`, `agent_pty_wait_for_exit`, `agent_pty_kill`, `agent_pty_remove`, `agent_pty_list_sessions`). It auto-starts the daemon on first use via `@agent-pty/core`.

## Building

```bash
# Install all workspace dependencies
bun install

# Compile daemon (required — must run under Node.js)
cd packages/core && bun run build   # tsc -p tsconfig.build.json
```

## TODO

- [x] Add `scroll` / scrollback access
- [ ] Add `resize` command
- [x] Integration tests
