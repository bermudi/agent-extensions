# ADR 0001: Delegate Subagent Spawning Model

**Status:** Accepted
**Date:** 2026-05-25

## Context

The `delegate` tool has grown organically. It now has 10 execution paths through combinations of `cwd`, `context` (fresh/inherit/fork), `sessionId`, and `resumeFrom`. The LLM calling delegate doesn't know which path to use for a given task. We don't have documented decisions about when to use which.

This ADR establishes the core design principle and derives the execution model from it.

## Core Principle

> **Every subagent always creates a recoverable session.**
>
> The caller doesn't predict whether an agent will fail, get stuck, or need follow-up.
> The system guarantees that regardless of outcome, the session can be resumed,
> inspected, or continued. Recovery is reactive, not proactive.

This means:
- No "ephemeral" vs "persistent" mode choice — every spawn creates a session file
- No upfront decision about whether the agent will need multiple turns
- If the agent fails, gets stuck, or has a question: the parent resumes from the session file
- `sessionId` is for *intentional* multi-turn, not recovery
- `resumeFrom` is for *recovery* — picking up from a previous session that didn't finish clean

## Current State

### What already works

- Every subagent already creates a session file (via `SessionManager.create(cwd)`)
- `parentSession` header links back to the calling project
- The session file path is returned in the delegate output
- `resumeFrom` can rehydrate from any .jsonl

### What's broken or unclear

1. **`fork` and `inherit` are nearly identical.** Both stuff the parent transcript into the prompt. The only difference is session file structure (standalone vs branch). Not worth two modes.

2. **`fork` + `cwd` is inconsistent.** Session file lives next to parent, tools operate in target cwd. Session and tools in different places.

3. **The output doesn't surface the session file prominently.** When a subagent fails, the parent should see "resume from this path" as the obvious next step.

4. **No recovery guidance for the LLM.** The help text doesn't say "when a subagent fails, use `resumeFrom` with the session path from the error output."

5. **`resumeFrom` + `sessionId` has a silent conflict** (resumeFrom ignored when pool hit).

## Decisions

### Decision 1: Every spawn is recoverable by default

All subagents create a session file. The session path is always visible in the output.
When a subagent fails or gets stuck, the output includes an explicit recovery instruction:

```
[FAILED: rate limit exceeded · session: ~/.pi/agent/sessions/project/2026-05-25_abc123.jsonl]
→ To retry: delegate({ tasks: [{ resumeFrom: "~/.pi/agent/sessions/project/2026-05-25_abc123.jsonl", prompt: "continue" }] })
```

The parent agent doesn't need to think about modes. It just sees the failure and the recovery path.

### Decision 2: Kill `fork`

**Remove `context: "fork"`.**

Rationale:
- `inherit` provides the same LLM-visible context (parent transcript in prompt)
- The only value of `fork` is structural (branch in `/resume` tree, searchable parent prefix)
- `fork` + `cwd` creates an inconsistency (session next to parent, tools in target)
- Session search already works via `parentSession` linking (inherit creates a child link too)
- Not worth the complexity and the `cwd` inconsistency

**Migration:** `context: "fork"` → treat same as `inherit` with a deprecation warning. Remove in next breaking version.

### Decision 3: Rename `inherit` to make the cost visible

Keep the feature (parent transcript injection) but rename it so the cost is explicit:
- `context: "with-parent-transcript"` — stuffs the full parent conversation into the subagent prompt
- Default remains `fresh` (no parent context)

Why keep it: there are genuine cases where the subagent needs to know what you've been doing. But it should be a deliberate, expensive choice — not the default.

### Decision 4: `cwd` is the cross-project mechanism

When `cwd` is set to a different project:
- Tools scope to that project
- AGENTS.md loads from that project (global + target, NOT parent project)
- Skills load from that project
- Session file created in that project's sessions
- `parentSession` links back to calling project
- No ambiguity about where things live

This is the blessed way to do cross-project delegation. Document it in AGENTS.md and the help text.

### Decision 5: `sessionId` is for intentional multi-turn, not recovery

- `sessionId` keeps an agent alive in memory for deliberate back-and-forth
- Auto-evicted after 10 min idle
- `cwd` locked on first call (config mismatch on reuse is an error)
- If a pooled agent fails, the parent can still `resumeFrom` the session file

### Decision 6: `resumeFrom` is always the recovery mechanism

- Works for any previous subagent session (failed, interrupted, or completed)
- Rehydrates full conversation history
- Can optionally combine with `sessionId` to promote the resumed agent to persistent
- The conflict with pool hits (resumeFrom silently ignored) should become a hard error, not a warning

## The Two Things a Caller Needs to Know

| I want to... | I use |
|---|---|
| Run a task (this project or another) | `delegate({ tasks: [{ prompt: "...", cwd?: "..." }] })` |
| Continue a failed/stuck agent | `delegate({ tasks: [{ resumeFrom: "<path from output>", prompt: "continue" }] })` |

Everything else (`sessionId`, `with-parent-transcript`, `agent`, `model`, etc.) is optional configuration. The core loop is **spawn → if failed → resume**.

### Decision 7: Session files live in the target cwd

The session file is created in the subagent's working directory — the project where the work actually happened.

Rationale:
- `pi -r` in the target project finds it naturally
- Files, git context, and session are all in the same place
- If you manually want to continue the subagent's work, you `cd` there and `pi -r`
- The parent link (`parentSession` header) is metadata for discoverability, not a filing system

What this means for `/resume`:
- `/resume` in the **parent** project should follow `parentSession` links to show delegate children, even if they live in a different project's session directory
- `/resume` in the **target** project shows the session as a regular session (the `parentSession` header is there but not surfaced specially)
- This is a `/resume` feature — delegate just writes the header correctly

| Concern | Result |
|---|---|
| `pi -r` in target project | ✅ Finds it as a regular session |
| `pi -r` in parent project | ✅ Via parentSession link (if /resume follows it) |
| Files/git context | ✅ Same cwd as the work |
| `/resume` tree in parent | ⚠️ Requires /resume to follow cross-project parentSession links |

## Resolved Questions

1. **Should `cwd` accept project names?** No. Absolute paths only. A name registry is complexity that doesn't earn its keep.

2. **Recovery instructions in tool output or help text?** Tool output. It appears at the exact moment the parent agent needs it.

3. **Should failed subagents auto-retry?** No. The parent agent handles retries. It sees the failure, gets the session path, and decides whether to `resumeFrom` or try a different approach. The system doesn't make that call.

## Consequences

- The LLM no longer picks a "mode" — it spawns, and recovers if needed
- Every subagent is inspectable and resumable by design
- `fork` removed (low impact — rare usage)
- `inherit` renamed to `with-parent-transcript` (makes cost visible)
- Recovery instructions appear inline in failure output
