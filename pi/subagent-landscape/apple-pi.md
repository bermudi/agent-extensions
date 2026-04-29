# apple-pi

**Repo:** https://github.com/ForeverAnApple/apple-pi  
**Author:** ForeverAnApple  
**NPM:** `apple-pi`

## Architecture

True in-process subagents using `@mariozechner/pi-agent-core`'s `Agent` class. No process spawning.

### Files (5 source files)

```
index.ts     — Extension entry point, registerTool("delegate"), TUI rendering
agents.ts    — Agent discovery (markdown file parsing)
executor.ts  — Single agent execution via pi-agent-core Agent class
tools.ts     — Build AgentTool[] from names using SDK factories
types.ts     — AgentConfig, RunResult
+ verification scripts (verify_discovery.ts, verify_inheritance.ts)
```

### The Delegate Tool

```typescript
delegate({
  tasks: [
    { agent: "scout", task: "Explore auth module" },
    { agent: "worker", task: "Fix login bug" }
  ]
})
```

- Parallel-only (no single-agent mode, no chains)
- `Promise.allSettled` fires all tasks concurrently
- Each gets its own `Agent` instance with own tool set

### In-Process Execution

```typescript
// executor.ts
const agent = new Agent({
  initialState: {
    systemPrompt: config.systemPrompt,
    model,
    thinkingLevel: config.thinking,
    tools: buildTools(config.tools, cwd),
  },
  convertToLlm,
  streamFn: async (m, context, options) => {
    const auth = await modelRegistry.getApiKeyAndHeaders(m);
    return streamSimple(m, context, { ...options, apiKey: auth.apiKey, headers: auth.headers });
  },
});

await agent.prompt(task);
await agent.waitForIdle();
// Extract output from agent.state.messages
```

Reuses parent's model, model registry, auth. No cold start. No pi binary resolution.

### Agent Definitions

Markdown files with YAML frontmatter:

```markdown
---
name: scout
description: Fast codebase reconnaissance
model: openai-codex/gpt-5.5
thinking: high
tools: read, grep, find, ls, bash, write
---

You are a scouting subagent running inside pi...
```

- Discovered from: `.pi/agents/` (project, walk-up), `~/.pi/agent/agents/` (user), `agents/` (bundled)
- Priority: project > user > bundled
- No settings.json overrides
- Unknown agent → error message with available names inline

### What It Doesn't Have

- No chains
- No async/background mode
- No intercom/coordination
- No control monitoring
- No clarification TUI
- No worktree isolation
- No management actions
- No fork context
- No model fallback

## Verdict

The cleanest architecture in the landscape. ~250 lines of actual logic (minus TUI rendering). Respects pi's philosophy: minimal, in-process, uses SDK primitives. The only thing it does beyond `pi -p` is parallelism — and it does exactly that with zero ceremony.
