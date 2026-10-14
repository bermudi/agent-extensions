/**
 * Drive real `pi --mode rpc` with only review.ts loaded, in a throwaway git
 * repo, and verify the /review selector round trip without any model calls.
 *
 * Usage: bun run scripts/rpc-review-smoke.ts <cancel | accept>
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2] ?? "cancel";
if (
  mode !== "cancel" &&
  mode !== "accept" &&
  mode !== "branch" &&
  mode !== "commit"
) {
  console.error(
    "usage: bun run scripts/rpc-review-smoke.ts <cancel|accept|branch|commit>",
  );
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "rpc-review-"));
const sessions = join(work, "sessions");
rmSync(join(work, "repo"), { recursive: true, force: true });
const repo = join(work, "repo");
const git = (args: string[], cwd: string = repo) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/git", args, { cwd, stdio: "ignore" });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`git ${args} → ${code}`)),
    );
  });
await git(["init", "-q", repo], work);
await git(["-C", repo, "config", "user.email", "smoke@example.com"]);
await git(["-C", repo, "config", "user.name", "smoke"]);
const seed = join(repo, "seed.txt");
await Bun.write(seed, "seed\n");
await git(["-C", repo, "add", "."], repo);
await git(["-C", repo, "commit", "-q", "-m", "seed commit"], repo);
await git(["-C", repo, "branch", "feature/x"], repo);

const pi = spawn(
  "/home/daniel/.pi/agent/bin/pi",
  [
    "--mode",
    "rpc",
    "--no-extensions",
    "-e",
    "/home/daniel/build/agent-extensions/pi-packages/bermudis-pi-goodies/review.ts",
    "--session-dir",
    sessions,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
    "--no-context-files",
    "--offline",
  ],
  {
    cwd: repo,
    stdio: ["pipe", "pipe", "pipe"],
    // Fake HOME so the subprocess sees no models and no credentials: the
    // accept-path review send fails locally instead of calling the operator's
    // provider. XDG_DATA_HOME stays real so pi's launcher finds its node.
    env: {
      ...process.env,
      HOME: join(work, "fakehome"),
      XDG_DATA_HOME: "/home/daniel/.local/share",
    },
  },
);

let stdout = "";
let stderr = "";
const records: Array<Record<string, unknown>> = [];
pi.stdout.on("data", (chunk: Buffer) => {
  stdout += chunk.toString();
  const lines = stdout.split("\n");
  stdout = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // ignore non-JSON lines
    }
  }
});
pi.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

const send = (record: unknown) => pi.stdin.write(`${JSON.stringify(record)}\n`);

let scanCursor = 0;
const nextEvent = (
  predicate: (record: Record<string, unknown>) => boolean,
  label: string,
) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `timeout waiting for ${label}; saw:\n${records.map((r) => String(r.type)).join("\n")}\nstderr: ${stderr}`,
        ),
      );
    }, 20_000);
    const poll = () => {
      while (scanCursor < records.length) {
        const record = records[scanCursor++];
        if (predicate(record)) {
          clearTimeout(timer);
          resolve(record);
          return;
        }
      }
      setTimeout(poll, 50);
    };
    poll();
  });

try {
  send({ id: "boot", type: "get_state" });
  await nextEvent(
    (r) => r.type === "response" && r.command === "get_state",
    "get_state response",
  );

  const presetAnswer =
    mode === "branch"
      ? "Review against a base branch (local or origin/*)"
      : mode === "commit"
        ? "Review a commit (recommended)"
        : undefined;
  send({
    id: "review-1",
    type: "prompt",
    message: presetAnswer === undefined ? "/review" : "/review",
  });

  const select = await nextEvent(
    (r) => r.type === "extension_ui_request" && r.method === "select",
    "select dialog",
  );
  const options = select.options;
  if (!Array.isArray(options) || options.length === 0)
    throw new Error(`no options: ${JSON.stringify(select)}`);
  console.log("SELECT REQUEST ✓");
  console.log("  title:", JSON.stringify(select.title));
  for (const option of options)
    console.log("  option:", JSON.stringify(option));

  const answerOrCancel = (): unknown => {
    if (mode === "cancel")
      return { type: "extension_ui_response", id: select.id, cancelled: true };
    if (presetAnswer === undefined) {
      const chosen = options.find((option) =>
        String(option).startsWith("Review uncommitted changes"),
      );
      if (chosen === undefined)
        throw new Error(`no uncommitted option in ${JSON.stringify(options)}`);
      return { type: "extension_ui_response", id: select.id, value: chosen };
    }
    if (!options.includes(presetAnswer))
      throw new Error(`missing preset option ${presetAnswer}`);
    return {
      type: "extension_ui_response",
      id: select.id,
      value: presetAnswer,
    };
  };
  send(answerOrCancel());

  if (mode === "branch" || mode === "commit") {
    const second = await nextEvent(
      (r) => r.type === "extension_ui_request" && r.method === "select",
      `${mode} select dialog`,
    );
    const secondOptions = second.options;
    if (!Array.isArray(secondOptions) || secondOptions.length === 0)
      throw new Error(`no ${mode} options: ${JSON.stringify(second)}`);
    console.log(
      `${mode.toUpperCase()} SELECT ✓ title:`,
      JSON.stringify(second.title),
    );
    for (const option of secondOptions)
      console.log("  option:", JSON.stringify(option));
    send({
      type: "extension_ui_response",
      id: second.id,
      value: secondOptions[0],
    });
  }

  const startPrefix = mode === "cancel" ? null : "Starting review";
  if (startPrefix === null) {
    const notify = await nextEvent(
      (r) => r.type === "extension_ui_request" && r.method === "notify",
      "cancel notify",
    );
    console.log("CANCEL NOTIFY ✓:", JSON.stringify(notify.message));
  } else {
    const notify = await nextEvent(
      (r) =>
        r.type === "extension_ui_request" &&
        r.method === "notify" &&
        String(r.message).startsWith(startPrefix),
      "starting-review notify",
    );
    console.log("START NOTIFY ✓:", JSON.stringify(notify.message));
  }

  const ack = await nextEvent(
    (r) => r.type === "response" && r.command === "prompt",
    "prompt ack",
  );
  console.log("PROMPT ACK ✓", JSON.stringify(ack));
  console.log(`SMOKE OK (${mode})`);
} finally {
  pi.kill("SIGKILL");
  // Leave the work dir for post-mortem on failure; clean it on success.
  if (stdout.includes("SMOKE OK"))
    rmSync(work, { recursive: true, force: true });
}
