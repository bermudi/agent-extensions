import net from "net";
import { Session } from "./session.js";
import { resolveKey } from "./keys.js";
import { mkdir, writeFile, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

const SOCK_DIR = process.env.AGENT_PTY_SOCK
  ? undefined
  : resolve(homedir(), ".agent-pty");
const SOCK_PATH = process.env.AGENT_PTY_SOCK ?? resolve(SOCK_DIR!, "daemon.sock");
const PID_PATH = SOCK_DIR ? resolve(SOCK_DIR, "daemon.pid") : undefined;

interface Command {
  id?: string | number;
  cmd: string;
  [key: string]: unknown;
}

interface Response {
  id?: string | number;
  ok: boolean;
  [key: string]: unknown;
}

class Daemon {
  sessions = new Map<string, Session>();
  server: net.Server | null = null;

  async start(): Promise<void> {
    if (SOCK_DIR) await mkdir(SOCK_DIR, { recursive: true });
    if (existsSync(SOCK_PATH)) {
      try {
        const client = net.createConnection(SOCK_PATH);
        client.on("connect", () => {
          client.end();
          console.error("Daemon already running");
          process.exit(1);
        });
        client.on("error", () => {
          // No daemon running; safe to remove stale socket
        });
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        // stale socket
      }
      try { await rm(SOCK_PATH); } catch {}
    }

    if (PID_PATH) await writeFile(PID_PATH, String(process.pid));

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    this.server.listen(SOCK_PATH, () => {
      console.error(`Daemon listening on ${SOCK_PATH}`);
    });

    // Cleanup on exit
    const cleanup = async () => {
      for (const s of this.sessions.values()) {
        try { s.kill(); } catch {}
      }
      try { await rm(SOCK_PATH); } catch {}
      if (PID_PATH) try { await rm(PID_PATH); } catch {}
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf-8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line) as Command;
          const res = await this.handleCommand(req, socket);
          socket.write(JSON.stringify(res) + "\n");
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          socket.write(JSON.stringify({ ok: false, error: err }) + "\n");
        }
      }
    });
    socket.on("error", () => {});
  }

  private async handleCommand(req: Command, socket: net.Socket): Promise<Response> {
    const { cmd, id } = req;
    const base = { id };

    switch (cmd) {
      case "spawn": {
        const name = String(req.name ?? "");
        const command = String(req.command ?? "");
        const args = Array.isArray(req.args) ? req.args.map(String) : [];
        const cwd = String(req.cwd ?? process.cwd());
        const cols = Number(req.cols ?? 80);
        const rows = Number(req.rows ?? 24);

        if (!name) return { ...base, ok: false, error: "missing --name" };
        if (!command) return { ...base, ok: false, error: "missing command" };
        if (this.sessions.has(name)) return { ...base, ok: false, error: `session already exists: ${name}` };

        const session = await Session.create(name, command, args, cwd, cols, rows, process.env);
        this.sessions.set(name, session);
        return { ...base, ok: true, name, pid: session.pty.pid };
      }

      case "type": {
        const name = String(req.name ?? "");
        const text = String(req.text ?? "");
        const session = this.sessions.get(name);
        if (!session) return { ...base, ok: false, error: `session not found: ${name}` };
        session.pty.write(text);
        return { ...base, ok: true };
      }

      case "key": {
        const name = String(req.name ?? "");
        const key = String(req.key ?? "");
        const session = this.sessions.get(name);
        if (!session) return { ...base, ok: false, error: `session not found: ${name}` };
        const seq = resolveKey(key);
        if (!seq) return { ...base, ok: false, error: `unknown key: ${key}` };
        session.pty.write(seq);
        return { ...base, ok: true, sent: seq };
      }

      case "snapshot": {
        const name = String(req.name ?? "");
        const format = (req.format as "full" | "text") ?? "text";
        const session = this.sessions.get(name);
        if (!session) return { ...base, ok: false, error: `session not found: ${name}` };
        const snap = session.snapshot(format);
        return { ...base, ok: true, ...snap };
      }

      case "wait-for": {
        const name = String(req.name ?? "");
        const pattern = String(req.pattern ?? "");
        const timeout = Number(req.timeout ?? 30000);
        const useRegex = Boolean(req.regex);
        const since = req.since !== undefined ? Number(req.since) : undefined;
        const session = this.sessions.get(name);
        if (!session) return { ...base, ok: false, error: `session not found: ${name}` };
        if (!pattern) return { ...base, ok: false, error: "missing pattern" };

        const re = useRegex ? new RegExp(pattern) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const start = Date.now();

        // Immediate check (skipped when --since is used)
        if (since === undefined) {
          if (re.test(session.getScreenText())) {
            return { ...base, ok: true, matched: true, elapsed: 0 };
          }
        }

        return new Promise((resolve) => {
          let disposed = false;
          let dataDisposable: { dispose(): void } | null = null;

          const timer = setTimeout(() => {
            if (disposed) return;
            disposed = true;
            if (dataDisposable) dataDisposable.dispose();
            resolve({ ...base, ok: true, matched: false, timedOut: true, elapsed: Date.now() - start });
          }, timeout);

          dataDisposable = session.pty.onData(() => {
            if (disposed) return;
            const snap = session.snapshot("text");
            if (since !== undefined && snap.snapshotId <= since) return;
            if (re.test(snap.text)) {
              disposed = true;
              if (dataDisposable) dataDisposable.dispose();
              clearTimeout(timer);
              resolve({ ...base, ok: true, matched: true, elapsed: Date.now() - start });
            }
          });

          socket.on("close", () => {
            if (!disposed) {
              disposed = true;
              if (dataDisposable) dataDisposable.dispose();
              clearTimeout(timer);
              resolve({ ...base, ok: false, error: "client disconnected" });
            }
          });
        });
      }

      case "await-change": {
        const name = String(req.name ?? "");
        const timeout = Number(req.timeout ?? 30000);
        const settle = Number(req.settle ?? 200);
        const session = this.sessions.get(name);
        if (!session) return { ...base, ok: false, error: `session not found: ${name}` };

        const initialHash = session.snapshot("text").contentHash;
        const start = Date.now();

        return new Promise((resolve) => {
          let settleTimer: ReturnType<typeof setTimeout> | null = null;
          let disposed = false;
          let dataDisposable: { dispose(): void } | null = null;
          let lastChangeHash: string | null = null;

          const deadline = setTimeout(() => {
            if (disposed) return;
            const currentHash = session.snapshot("text").contentHash;
            const changed = currentHash !== initialHash;
            cleanup();
            resolve({
              ...base,
              ok: true,
              changed,
              timedOut: true,
              ...(changed ? { contentHash: currentHash } : {}),
              elapsed: Date.now() - start,
            });
          }, timeout);

          const cleanup = () => {
            disposed = true;
            if (dataDisposable) dataDisposable.dispose();
            if (settleTimer) clearTimeout(settleTimer);
            clearTimeout(deadline);
          };

          const checkSettled = () => {
            if (disposed) return;
            const currentHash = session.snapshot("text").contentHash;
            if (currentHash !== initialHash) {
              cleanup();
              resolve({
                ...base,
                ok: true,
                changed: true,
                settled: true,
                contentHash: currentHash,
                elapsed: Date.now() - start,
              });
            }
          };

          dataDisposable = session.pty.onData(() => {
            if (disposed) return;
            const currentHash = session.snapshot("text").contentHash;

            if (currentHash === initialHash) return;

            if (settle <= 0) {
              cleanup();
              resolve({
                ...base,
                ok: true,
                changed: true,
                settled: false,
                contentHash: currentHash,
                elapsed: Date.now() - start,
              });
              return;
            }

            if (currentHash !== lastChangeHash) {
              lastChangeHash = currentHash;
              if (settleTimer) clearTimeout(settleTimer);
              settleTimer = setTimeout(checkSettled, settle);
            }
          });

          socket.on("close", () => {
            if (!disposed) {
              cleanup();
              resolve({ ...base, ok: false, error: "client disconnected" });
            }
          });
        });
      }

      case "kill": {
        const name = String(req.name ?? "");
        const signal = req.signal ? String(req.signal) : undefined;
        const session = this.sessions.get(name);
        if (!session) return { ...base, ok: false, error: `session not found: ${name}` };
        session.kill(signal);
        return { ...base, ok: true, killedAt: session.killedAt!.toISOString() };
      }

      case "remove": {
        const name = String(req.name ?? "");
        const session = this.sessions.get(name);
        if (!session) return { ...base, ok: false, error: `session not found: ${name}` };
        this.sessions.delete(name);
        return { ...base, ok: true };
      }

      case "scroll": {
        const name = String(req.name ?? "");
        const lines = Number(req.lines ?? 0);
        const session = this.sessions.get(name);
        if (!session) return { ...base, ok: false, error: `session not found: ${name}` };
        const scroll = session.scrollback(lines);
        return { ...base, ok: true, lines: scroll.lines, text: scroll.text };
      }

      case "wait-for-exit": {
        const name = String(req.name ?? "");
        const timeout = Number(req.timeout ?? 30000);
        const session = this.sessions.get(name);
        if (!session) return { ...base, ok: false, error: `session not found: ${name}` };

        // Already exited?
        if (session.exitInfo) {
          return { ...base, ok: true, exited: true, ...session.exitInfo };
        }

        const start = Date.now();
        return new Promise((resolve) => {
          let disposed = false;
          let exitDisposable: { dispose(): void } | null = null;

          const timer = setTimeout(() => {
            if (disposed) return;
            disposed = true;
            if (exitDisposable) exitDisposable.dispose();
            resolve({ ...base, ok: true, exited: false, timedOut: true, elapsed: Date.now() - start });
          }, timeout);

          exitDisposable = session.pty.onExit((e) => {
            if (disposed) return;
            disposed = true;
            if (exitDisposable) exitDisposable.dispose();
            clearTimeout(timer);
            resolve({ ...base, ok: true, exited: true, exitCode: e.exitCode, signal: e.signal, elapsed: Date.now() - start });
          });

          socket.on("close", () => {
            if (!disposed) {
              disposed = true;
              if (exitDisposable) exitDisposable.dispose();
              clearTimeout(timer);
              resolve({ ...base, ok: false, error: "client disconnected" });
            }
          });
        });
      }

      case "list-sessions": {
        const list = Array.from(this.sessions.values()).map((s) => ({
          name: s.name,
          command: s.command,
          cwd: s.cwd,
          pid: s.pty.pid,
          createdAt: s.createdAt.toISOString(),
          ...(s.killedAt ? { killedAt: s.killedAt.toISOString() } : {}),
        }));
        return { ...base, ok: true, sessions: list };
      }

      case "shutdown": {
        for (const s of this.sessions.values()) {
          try { s.kill(); } catch {}
        }
        this.sessions.clear();
        this.server?.close();
        return { ...base, ok: true };
      }

      default:
        return { ...base, ok: false, error: `unknown command: ${cmd}` };
    }
  }
}

const daemon = new Daemon();
daemon.start().catch((e) => {
  console.error("Daemon failed:", e);
  process.exit(1);
});
