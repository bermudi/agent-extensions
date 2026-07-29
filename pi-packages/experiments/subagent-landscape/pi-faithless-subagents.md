# pi-faithless-subagents

**Author:** faithless  
**NPM:** `pi-faithless-subagents`  
**Note:** No public repo. Inspected from npm tarball.

## Architecture

"PI-native constrained subagent orchestration library." The most architecturally distinct approach in the landscape.

### Core Concept: "Faithless"

The name means: **don't trust the model**. Every subagent is constrained by policies that limit what files it can read/write, what tools it can use, and how many turns it can take. The orchestrator enforces topological execution order and validates outputs between steps.

### Role-Based Policies

Four fixed roles (not user-definable):

| Role | Purpose | Policy |
|------|---------|--------|
| `explorer` | Codebase reconnaissance | Read-only, wide read scope |
| `planner` | Implementation planning | Read + write (plan files), narrow write scope |
| `worker` | Implementation | Read + write, narrow write scope |
| `reviewer` | Review and fix | Read + edit, narrow write scope |

Each role has a predefined:
- Output artifact kind (what it produces)
- Output file name
- Tool access policy
- File path constraints (allowedReadPaths, allowedWritePaths)

### Execution Model

```
Workflow (DAG of steps)
  └─ Topological sort → layers
       └─ Layer N: parallel execution of independent steps
            └─ Step: in-memory pi session with constrained tools
                 └─ Output: validated artifact → passed to dependents
```

Dependencies form a DAG. Steps in the same layer (no inter-dependencies) run in parallel. Artifacts flow forward through `inputArtifacts` declarations.

### Runner

`PiNativeRunner`:
- Creates in-memory pi sessions (`SessionManager.inMemory()`)
- Custom tool definitions filtered by role policy
- Tool call limit enforcement (aborts session if exceeded)
- Prompt size limits (DEFAULT_MAX_PROMPT_BYTES)
- Tool result size limits
- Artifact size limits

Uses `@mariozechner/pi-agent-core`'s `Agent` class + `streamSimple` from `@mariozechner/pi-ai`.

### Policy Enforcement

- `assertStepPolicy()` — validates step against host context
- `assertNoWriteConflicts()` — prevents two steps writing to same path
- `assertPiHostToolPathAccess()` — validates tool arguments against allowed paths
- `validateArtifactText()` — validates output meets role expectations

### Retry & Timeout

- Configurable `retryLimit` per step
- Configurable `timeoutMs` per step
- Retryable errors (non-policy errors) get retried
- Non-retryable errors (policy violations) fail immediately

### pi Extension Adapter

A thin bridge (`pi-extension.ts`) that exposes two tools:
- `pi_subagents_run_workflow` — full DAG workflow
- `pi_subagents_run_step` — single step as one-step workflow

### What It Doesn't Have

- Named/discoverable agents (roles are fixed)
- Agent management UI
- Async/background mode
- Intercom/coordination
- Fork context
- Model selection per step (uses parent model)
- Agent definition files (roles are code)

## Verdict

Most architecturally interesting. The constraint-first approach solves the "subagent runs wild" problem at the infrastructure level. But the fixed roles + rigid artifact passing make it more of a CI pipeline than a flexible delegation tool. The OpenAI dependency is weird for a "PI-native" tool. The core ideas (policy enforcement, topological execution, artifact validation) are worth stealing.
