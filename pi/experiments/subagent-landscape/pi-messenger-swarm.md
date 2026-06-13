# pi-messenger-swarm

**Repo:** https://github.com/monotykamary/pi-messenger-swarm  
**Author:** monotykamary  
**NPM:** `pi-messenger-swarm`

## Architecture

This is not a subagent task delegation system — it's a **cross-session communication platform**. Think "IRC for pi sessions" rather than "delegate this task."

### Key Concepts

- **Agents register** themselves by name to a shared directory
- **Harness server** handles action dispatch (long-lived process)
- **Channels** organize communication (like IRC channels)
- **File-based coordination**: agent registrations, messages, reservations all stored as files in `~/.pi/messenger/`
- **TUI overlay** for viewing messages, channels, agent status within pi

### Spawning (for actual execution)

Swarm spawning creates pi CLI subprocesses:

```
swarm/spawn.ts — ChildProcess spawning via node:child_process
```

- Spawns pi processes, parses JSONL output for progress
- Event-sourced persistence (JSONL append)
- Agent definition files written to `.pi/messenger/agents/`
- `stopAllSpawned()` for cleanup

### Tool Surface

Models interact via CLI, not tool calls — the SKILL.md teaches models to use `pi-messenger-swarm` CLI commands. This avoids the "eager invocation" problem where models call tools without understanding them.

### Complexity

60+ TypeScript source files. Major subsystems:
- `extension/` — lifecycle hooks (registration, status, overlay, reservations, shutdown, activity)
- `swarm/` — task spawning, progress, labels, agent loader, task store with commands/events/queries/persistence
- `overlay/` — TUI rendering (feed window, input, notifications, layout, status, config)
- `feed/` — feed scrolling and event logging
- `store/` — agent registry, registration state, shared state
- `handlers/` — coordination (join, list, messaging, rename, reservations, status, whois)
- `harness/` — CLI and server for the harness process

## Verdict

Interesting concept but addresses a completely different problem from subagent task delegation. If you want multiple pi sessions to discover and message each other (like "hey, the auth module review is done, check the results"), this does that. But for "run this review in parallel while I continue working," apple-pi or even `pi -p` is simpler.
