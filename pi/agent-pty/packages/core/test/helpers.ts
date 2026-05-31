import net from "net";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawn, type Subprocess } from "bun";

// ── Types ──────────────────────────────────────────────────────────────

export interface CommandResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

// ── Socket client (independent from production client.ts) ──────────────

export function send(
  sockPath: string,
  cmd: Record<string, unknown>,
  timeout = 30000,
): Promise<CommandResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(sockPath);
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      try { client.end(); } catch {}
    };

    client.on("connect", () => {
      client.write(JSON.stringify(cmd) + "\n");
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`request timeout after ${timeout}ms`));
      }, timeout);
    });

    client.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        const line = buffer.slice(0, nl);
        cleanup();
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error(`invalid JSON: ${line}`));
        }
      }
    });

    client.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

// ── Daemon test harness ────────────────────────────────────────────────

export class DaemonHarness {
  tempDir: string;
  sockPath: string;
  pidPath: string;
  private proc: Subprocess | null = null;
  private _id = 0;

  constructor() {
    this.tempDir = mkdtempSync(join(tmpdir(), "agent-pty-test-"));
    this.sockPath = join(this.tempDir, "daemon.sock");
    this.pidPath = join(this.tempDir, "daemon.pid");
  }

  /** Start daemon and wait for readiness. Throws if daemon fails to start. */
  async start(): Promise<void> {
    this.proc = spawn({
      cmd: ["node", resolve(import.meta.dir, "../dist/daemon.js")],
      env: { ...process.env, AGENT_PTY_SOCK: this.sockPath },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for daemon to accept connections
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const res = await this.cmd("list-sessions");
        if (res.ok) return;
      } catch {
        // still starting
      }
    }
    throw new Error("daemon failed to start within 5s");
  }

  /** Send a command to the daemon. Auto-increments id. */
  cmd(
    cmd: string,
    args: Record<string, unknown> = {},
    timeout = 30000,
  ): Promise<CommandResponse> {
    return send(this.sockPath, { id: `t-${++this._id}`, cmd, ...args }, timeout);
  }

  /** Send a shutdown and kill the process if it doesn't exit. */
  async stop(): Promise<void> {
    try {
      await this.cmd("shutdown", {}, 2000);
    } catch {
      // daemon might already be gone
    }
    if (this.proc) {
      // Give it 2s to exit gracefully
      const exitPromise = this.proc.exited;
      const timeout = new Promise((r) => setTimeout(r, 2000));
      await Promise.race([exitPromise, timeout]);
      try { this.proc.kill(); } catch {}
    }
    rmSync(this.tempDir, { recursive: true, force: true });
  }

  /** Spawn a bash session and wait for the prompt to appear. */
  async spawnShell(
    name: string,
    opts: { cols?: number; rows?: number; cwd?: string } = {},
  ): Promise<CommandResponse> {
    const res = await this.cmd("spawn", {
      name,
      command: "bash",
      args: ["--norc", "--noprofile"],
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    if (!res.ok) return res;

    // Wait for prompt — no static sleeps
    await this.cmd("wait-for", {
      name,
      pattern: "\\$",
      regex: true,
      timeout: 5000,
    }, 6000);

    return res;
  }

  /** Read daemon stderr for debugging. */
  async stderr(): Promise<string> {
    if (!this.proc) return "";
    const stream = this.proc.stderr;
    if (!stream || typeof stream === "number") return "";
    const bytes = await new Response(stream).text();
    return bytes;
  }
}
