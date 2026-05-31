#!/usr/bin/env bun
import { sendCommand, ensureDaemon } from "@agent-pty/core";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const command = args[0];
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
        flags[arg.slice(2)] = args[++i]!;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      const key = arg.slice(1);
      if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
        flags[key] = args[++i]!;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, flags, positional };
}

function printJson(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const { command, flags, positional } = parseArgs(process.argv);

  if (!command) {
    console.error("Usage: agent-pty <command> [options]");
    console.error("Commands: daemon, spawn, type, key, snapshot, wait-for, await-change, kill, list-sessions");
    process.exit(1);
  }

  if (command === "daemon") {
    const { spawn } = await import("child_process");
    const { fileURLToPath } = await import("url");
    const daemonPath = fileURLToPath(await import.meta.resolve("@agent-pty/core/daemon"));
    const proc = spawn("node", [daemonPath], { stdio: "inherit" });
    proc.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  await ensureDaemon();

  const id = crypto.randomUUID();

  switch (command) {
    case "spawn": {
      const name = String(flags.name ?? flags.n ?? "");
      const cwd = String(flags.cwd ?? process.cwd());
      const cols = Number(flags.cols ?? 80);
      const rows = Number(flags.rows ?? 24);
      const cmdName = positional[0];
      const args = positional.slice(1);
      if (!name) {
        console.error("Missing --name");
        process.exit(1);
      }
      if (!cmdName) {
        console.error("Missing command");
        process.exit(1);
      }
      const res = await sendCommand({
        id,
        cmd: "spawn",
        name,
        command: cmdName,
        args,
        cwd,
        cols,
        rows,
      });
      printJson(res);
      break;
    }

    case "type": {
      const name = String(flags.s ?? flags.session ?? "");
      const text = positional.join(" ");
      if (!name) {
        console.error("Missing -s/--session");
        process.exit(1);
      }
      const res = await sendCommand({ id, cmd: "type", name, text });
      printJson(res);
      break;
    }

    case "key": {
      const name = String(flags.s ?? flags.session ?? "");
      const key = positional[0];
      if (!name) {
        console.error("Missing -s/--session");
        process.exit(1);
      }
      if (!key) {
        console.error("Missing key argument");
        process.exit(1);
      }
      const res = await sendCommand({ id, cmd: "key", name, key });
      printJson(res);
      break;
    }

    case "snapshot": {
      const name = String(flags.s ?? flags.session ?? "");
      const format = (flags.f ?? flags.format ?? "text") as "full" | "text";
      if (!name) {
        console.error("Missing -s/--session");
        process.exit(1);
      }
      const res = await sendCommand({ id, cmd: "snapshot", name, format });
      printJson(res);
      break;
    }

    case "wait-for": {
      const name = String(flags.s ?? flags.session ?? "");
      const pattern = positional[0];
      const timeout = Number(flags.t ?? flags.timeout ?? 30000);
      const regex = Boolean(flags.r ?? flags.regex ?? false);
      if (!name) {
        console.error("Missing -s/--session");
        process.exit(1);
      }
      if (!pattern) {
        console.error("Missing pattern argument");
        process.exit(1);
      }
      const res = await sendCommand({ id, cmd: "wait-for", name, pattern, timeout, regex }, timeout + 5000);
      printJson(res);
      break;
    }

    case "await-change": {
      const name = String(flags.s ?? flags.session ?? "");
      const timeout = Number(flags.t ?? flags.timeout ?? 30000);
      const settle = Number(flags["settle"] ?? 200);
      if (!name) {
        console.error("Missing -s/--session");
        process.exit(1);
      }
      const res = await sendCommand({ id, cmd: "await-change", name, timeout, settle }, timeout + 5000);
      printJson(res);
      break;
    }

    case "kill": {
      const name = String(flags.s ?? flags.session ?? "");
      const signal = flags.signal ? String(flags.signal) : undefined;
      if (!name) {
        console.error("Missing -s/--session");
        process.exit(1);
      }
      const res = await sendCommand({ id, cmd: "kill", name, ...(signal ? { signal } : {}) });
      printJson(res);
      break;
    }

    case "list-sessions": {
      const res = await sendCommand({ id, cmd: "list-sessions" });
      printJson(res);
      break;
    }

    case "stop": {
      const res = await sendCommand({ id, cmd: "shutdown" });
      printJson(res);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
