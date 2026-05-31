import net from "net";
import { resolve, dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const SOCK_PATH = process.env.AGENT_PTY_SOCK ?? resolve(homedir(), ".agent-pty", "daemon.sock");

function resolveDaemonPath(): string {
  if (process.env.AGENT_PTY_DAEMON_CMD) {
    return process.env.AGENT_PTY_DAEMON_CMD;
  }
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const isDist = thisDir.endsWith("/dist") || thisDir.endsWith("\\dist");
  const distDir = isDist ? thisDir : join(thisDir, "..", "dist");
  return join(distDir, "daemon.js");
}

interface Command {
  id: string;
  cmd: string;
  [key: string]: unknown;
}

export function sendCommand(cmd: Command, timeout = 30000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCK_PATH);
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try { client.end(); } catch {}
    };

    client.on("connect", () => {
      client.write(JSON.stringify(cmd) + "\n");
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("request timeout"));
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
        } catch (e) {
          reject(new Error(`invalid JSON: ${line}`));
        }
      }
    });

    client.on("error", (err) => {
      cleanup();
      reject(err);
    });

    client.on("close", () => {
      if (timer) clearTimeout(timer);
    });
  });
}

export async function ensureDaemon(): Promise<void> {
  try {
    await sendCommand({ id: "ping", cmd: "list-sessions" }, 500);
    return;
  } catch {
    // Not running; start it
  }

  const { spawn } = await import("child_process");
  const cmdParts = process.env.AGENT_PTY_DAEMON_CMD?.split(" ") ?? ["node", resolveDaemonPath()];
  if (!cmdParts[0]) throw new Error("AGENT_PTY_DAEMON_CMD is empty");
  const daemonProc = spawn(cmdParts[0], cmdParts.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  daemonProc.unref();

  // Wait for daemon to be ready
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      await sendCommand({ id: "ping", cmd: "list-sessions" }, 500);
      return;
    } catch {
      // still starting
    }
  }
  throw new Error("daemon failed to start");
}
