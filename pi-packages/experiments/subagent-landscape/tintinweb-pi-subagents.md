# tintinweb/pi-subagents

**Repo:** https://github.com/tintinweb/pi-subagents  
**Author:** tintinweb  
**NPM:** `@tintinweb/pi-subagents`

## Architecture

"Claude Code-style autonomous sub-agents" — in-process execution using pi SDK's session primitives.

### Key Difference from nicobailon's

Nicobailon's spawns `pi` CLI processes. Tintinweb's uses `createAgentSession` + `AgentSession` from `@mariozechner/pi-coding-agent` — in-process session creation.

### Tool Surface

Three tools:

1. **`Agent`** — spawn a sub-agent
   ```typescript
   Agent({ type: "explorer", prompt: "Review auth module", background: false })
   ```

2. **`get_subagent_result`** — check background agent status/result
   ```typescript
   get_subagent_result({ id: "abc123" })
   ```

3. **`steer_subagent`** — send a steering message to a running agent
   ```typescript
   steer_subagent({ id: "abc123", message: "Focus on edge cases" })
   ```

Plus slash commands: `/agents` for interactive management.

### Agent Types

Subagents are typed, not named: `explorer`, `coder`, `thinker`, `reviewer`, `default`. Each type has preset:
- System prompt
- Tool set
- Model (configurable)
- Turn limit (soft + grace)
- Prompt mode ("minimal", "plan", "act", "full")

### Execution Flow

1. `agent-runner.ts` creates an `AgentSession` with `SessionManager.inMemory()`
2. Builds parent context (extracts relevant context from parent)
3. Preloads skills
4. Runs the prompt with turn tracking
5. On soft limit: sends steering message ("You've been running for N turns...")
6. Background mode: writes to JSONL event log, pollable via `get_subagent_result`

### Agent Manager

Interactive TUI (`/agents`) for:
- Viewing running agents with live tool status
- Killing agents
- Viewing agent output/conversation
- Configuring default types

### What It Has That apple-pi Doesn't

- Background/async execution
- Turn limits + steering
- Agent types (not named agents)
- Interactive agent manager TUI
- Config via settings.json
- Agent context building (extracts relevant parent context)
- Join modes (auto/human approval)

### What It Doesn't Have

- Chains
- Parallel execution (one agent at a time)
- Worktree isolation
- Intercom bridge
- Fork context
- Management actions for creating/deleting agents

## Verdict

A middle ground. In-process execution is better than pi-spawn. The agent type system (explorer/coder/reviewer) is simpler than named agents + discovery. But still ~1600 lines in index.ts, still has features that could be external (TUI manager, background mode, steering). The core execution is solid — it uses pi's session API correctly.
