# pi Subagent Landscape

Audit of pi subagent extensions published on the pi package registry, April 2026.

## The Three Architectural Families

### 1. In-Process SDK (pi-agent-core Agent class)

These create `Agent` instances directly, sharing the parent's Node runtime.

**apple-pi** (ForeverAnApple)
- 5 source files: index.ts, agents.ts, executor.ts, tools.ts, types.ts
- Single `delegate` tool: `{ tasks: [{ agent, task }] }`
- Parallel via `Promise.allSettled` — fire all at once
- Uses `new Agent({ initialState, convertToLlm, streamFn })` from `@mariozechner/pi-agent-core`
- Parent model by default, optionally `agent.model` override
- Tools built from SDK factories (`createReadTool`, `createBashTool`, etc.)
- Agent definitions: markdown files with YAML frontmatter in `.pi/agents/`
- Discovery at call time: `discoverAgents(cwd)` → `Map<string, AgentConfig>`
- Unknown agent → error message with available names inline
- No chains, no intercom, no control events, no management actions, no async
- Source: 2152 bytes for index.ts, ~4500 for executor.ts

**tintinweb/pi-subagents** (~24 source files)
- "Claude Code-style autonomous sub-agents"
- Uses `createAgentSession` + `AgentSession` from `@mariozechner/pi-coding-agent`
- Tools: `Agent` (spawn), `get_subagent_result` (poll), `steer_subagent` (send message)
- Has agent types (explorer, coder, reviewer, etc.), agent manager UI
- Background agents with JSONL event sourcing
- Turn limits with grace turns + steering messages
- Join modes (auto/human approval)
- Agent definitions in `~/.pi/agent/agents/` and `.pi/agents/`
- Still has a lot of features but runs in-process rather than spawning pi CLI
- Deeper integration with pi's session system (SessionManager, SettingsManager)

**pi-subagentura** (lmn451) — claimed "in-process sub-agents via the SDK", not inspected

### 2. Process Spawning (pi CLI subprocess)

These spawn separate `pi` processes for each subagent.

**nicobailon/pi-subagents** (the one currently installed)
- 50+ source files, ~68KB
- Spawns `pi` CLI processes via `pi-spawn.ts`
- Resolves pi binary path, constructs args, spawns child process
- Full cold startup per subagent
- Fork context = branched session file + full parent transcript dump
- Chains, parallel, worktree isolation, intercom bridge, control monitoring
- Management actions (list/get/create/update/delete)
- 8 builtin role-playing agents
- TUI clarification, async execution, result watching
- 38K downloads/month

**pi-messenger-swarm** (monotykamary)
- A different paradigm entirely: file-based cross-session messaging
- Not task delegation — session-to-session communication
- Harness server for action dispatch
- Swarm spawning (also pi CLI subprocess)
- File-based coordination: registration files, messages as files
- TUI overlay with feed, channels, agent list
- 60+ source files, complex architecture
- Better understood as "IRC for pi sessions" than "subagent delegation"

### 3. Constrained/Policy-Based

These impose explicit constraints on what agents can do.

**pi-faithless-subagents** (faithless)
- Uses OpenAI directly (separate from pi SDK for execution)
- Has `PiNativeRunner` that creates in-memory pi sessions with custom tool sets
- Role-based: explorer, planner, worker, reviewer
- Policies per role restrict tool access (read/write paths)
- Topological workflow execution (dependency DAG → layer-by-layer parallel)
- Artifact passing between steps
- Retry with configurable limits
- Timeout per step
- "Faithless" = doesn't trust the model, enforces hard constraints
- Also has a pi extension adapter that bridges into pi's tool system
- ~14 source files, TypeScript compiled to JS

## What Everyone Gets Wrong

1. **Agent discovery is a runtime concern.** Every extension has its own discovery system (user dir, project dir, bundled, settings overrides). The LLM can never know what agents are available without calling a list/discover function first. This is the two-call tax problem.

2. **Too many features.** nicobailon's has chains, parallel, async, intercom, control, clarify TUI, management, worktrees. tintinweb's has agent types, background, steering, join modes. Even pi-faithless-subagents has workflows, policies, retries, timeouts. The feature set expands to fill the imagination.

3. **Agent definitions are a separate DSL.** Every extension invents its own markdown frontmatter schema for defining agents, with slightly different field names and semantics.

4. **No one agrees on the right granularity.** pi-subagents spawns processes. apple-pi reuses the runtime. pi-faithless-subagents uses OpenAI directly. Each has different tradeoffs around isolation vs warm-start cost vs SDK coupling.

## The Simplest Thing That Could Work

From Mario's blog post:

```
pi -p "Review this diff for edge cases" 
```

A subagent is just pi with a prompt. Everything else is infrastructure for composing multiple prompts together or managing state between them — which a bash script can do.

The only genuinely missing primitive is **parallel execution from within a pi session**. `Promise.all` on `Agent.prompt()` calls, which is what apple-pi does. Everything else can be built outside the extension.
