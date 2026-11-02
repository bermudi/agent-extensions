// Connector-level tests. The child processes, sockets, and protocol frames
// here are SYNTHETIC doubles — they drive the connectors through their real
// constructors but are not captured from the observed devin/piz interfaces
// (unverified protocol fakes; see README "Protocol facts" for what is real).
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { DevinConnector } from "./devin.ts";
import { connectPiz, PizConnector } from "./piz.ts";
import type { ConnectOptions, Logger } from "./types.ts";

const OVER = 8 * 1024 * 1024 + 1;
const flush = () => new Promise((r) => setTimeout(r, 0));
const signal = () => new AbortController().signal;
const noActivity = { onActivity: () => undefined };

function recordLog() {
  const events: {
    level: string;
    event: string;
    data?: Record<string, unknown>;
  }[] = [];
  const log: Logger = {
    info: (event, data) => events.push({ level: "info", event, data }),
    warn: (event, data) => events.push({ level: "warn", event, data }),
    error: (event, data) => events.push({ level: "error", event, data }),
  };
  return { events, log };
}

/** Minimal ChildProcess double: captures stdin frames, stdout is fed by tests. */
class FakeChild extends EventEmitter {
  readonly written: string[] = [];
  stdinEnded = false;
  stdin = {
    write: (line: string) => {
      this.written.push(line);
      return true;
    },
    end: () => {
      this.stdinEnded = true;
    },
  };
  stdout: EventEmitter & { setEncoding(e: string): void } = Object.assign(
    new EventEmitter(),
    { setEncoding: () => undefined },
  );
  stderr: EventEmitter & { setEncoding(e: string): void } = Object.assign(
    new EventEmitter(),
    { setEncoding: () => undefined },
  );
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill(sig?: string): boolean {
    this.signalCode = sig ?? "SIGTERM";
    queueMicrotask(() => this.emit("exit", null, this.signalCode));
    return true;
  }
  frames(): Record<string, unknown>[] {
    return this.written.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  lastId(): unknown {
    return this.frames().at(-1)?.id;
  }
  respond(id: unknown, result: unknown) {
    this.stdout.emit("data", `${JSON.stringify({ id, result })}\n`);
  }
  fail(id: unknown, message: string) {
    this.stdout.emit(
      "data",
      `${JSON.stringify({ id, error: { code: -32000, message } })}\n`,
    );
  }
}

/** Minimal net.Socket double. */
class FakeSocket extends EventEmitter {
  readonly written: string[] = [];
  destroyed = false;
  write(line: string) {
    this.written.push(line);
    return true;
  }
  setEncoding(_e: string) {
    return this;
  }
  destroy() {
    this.destroyed = true;
    return this;
  }
  frames(): Record<string, unknown>[] {
    return this.written.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  lastId(): unknown {
    return this.frames().at(-1)?.id;
  }
}

function makeDevin(onClosed?: (error: Error) => void) {
  const { events, log } = recordLog();
  const child = new FakeChild();
  const options: ConnectOptions = {
    cwd: "/tmp",
    model: "swe-2-medium",
    log,
    onClosed,
  };
  const connector = new DevinConnector(
    child as unknown as ChildProcess,
    options,
  );
  return { child, connector, events };
}

function makePiz(onClosed?: (error: Error) => void) {
  const { events, log } = recordLog();
  const child = new FakeChild();
  const socket = new FakeSocket();
  const socketDir = mkdtempSync(join(tmpdir(), "fusion-piz-test-"));
  const options: ConnectOptions = {
    cwd: "/tmp",
    model: "GLM-5.3",
    log,
    onClosed,
  };
  const connector = new PizConnector(
    child as unknown as ChildProcess,
    socket as unknown as Socket,
    options,
    socketDir,
  );
  return { child, socket, connector, events, socketDir };
}

describe("DevinConnector inject draining", () => {
  test("the connector stays busy until every injected prompt settles, including one sent mid-drain", async () => {
    const { child, connector } = makeDevin();
    connector.sessionId = "s1";
    const outcome = connector.prompt("main", noActivity, signal());
    const mainId = child.lastId();
    void connector.inject("u1");
    const inject1 = child.lastId();
    child.respond(mainId, { stopReason: "end_turn" });
    await flush(); // the main continuation has begun: the drain is waiting on u1
    // The turn is still active mid-drain, so more updates are still injected...
    await expect(connector.inject("u2")).resolves.toBe(true);
    const inject2 = child.lastId();
    // ...session traffic during the drain still lands in the report...
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "text written during drain" },
          },
        },
      })}\n`,
    );
    // ...and a fresh prompt is refused.
    await expect(
      connector.prompt("sneak", noActivity, signal()),
    ).rejects.toThrow(/already has a running turn/);
    let settled = false;
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    child.respond(inject1, {});
    await flush();
    // u2 joined the drain; it must settle before the turn is reported.
    expect(settled).toBe(false);
    child.respond(inject2, {});
    const o = await outcome;
    expect(o.stopReason).toBe("end_turn");
    expect(o.report).toContain("text written during drain");
  });

  test("an unanswered inject keeps the connector busy well past any settle window", async () => {
    const { child, connector } = makeDevin();
    const outcome = connector.prompt("main", noActivity, signal());
    const mainId = child.lastId();
    void connector.inject("u1");
    const injectId = child.lastId();
    let settled = false;
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    child.respond(mainId, { stopReason: "end_turn" });
    // Longer than the old 1.5s inject-settle timeout: still draining, still busy.
    await new Promise((r) => setTimeout(r, 1600));
    expect(settled).toBe(false);
    await expect(
      connector.prompt("sneak", noActivity, signal()),
    ).rejects.toThrow(/already has a running turn/);
    child.respond(injectId, {});
    await expect(outcome).resolves.toBeDefined();
  });

  test("a rejected inject surfaces as a warning, not a dropped update", async () => {
    const { child, connector } = makeDevin();
    const outcome = connector.prompt("main", noActivity, signal());
    const mainId = child.lastId();
    void connector.inject("u1");
    const injectId = child.lastId();
    child.respond(mainId, { stopReason: "end_turn" });
    child.fail(injectId, "turn already over");
    const o = await outcome;
    expect(o.warnings?.join("\n")).toMatch(
      /rejected by devin: turn already over/,
    );
  });

  test("a failed main request still drains pending injects before rejecting", async () => {
    const { child, connector } = makeDevin();
    const outcome = connector.prompt("main", noActivity, signal());
    const mainId = child.lastId();
    void connector.inject("u1");
    const injectId = child.lastId();
    let settled = false;
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    child.fail(mainId, "main blew up");
    await flush();
    expect(settled).toBe(false); // still draining the inject
    child.respond(injectId, {});
    await expect(outcome).rejects.toThrow("main blew up");
  });

  test("transport death unblocks a prompt that is draining an unanswered inject", async () => {
    const closed: string[] = [];
    const { child, connector } = makeDevin((e) => closed.push(e.message));
    const outcome = connector.prompt("main", noActivity, signal());
    const mainId = child.lastId();
    void connector.inject("u1"); // never answered
    child.respond(mainId, { stopReason: "end_turn" });
    await flush();
    child.emit("exit", 1); // peer close rejects the pending inject; drain ends
    await expect(outcome).resolves.toBeDefined();
    expect(closed).toEqual(["devin acp exited (1)"]);
    await connector.dispose();
  });

  test("dispose unblocks a prompt that is draining an unanswered inject", async () => {
    const { child, connector } = makeDevin();
    const outcome = connector.prompt("main", noActivity, signal());
    const mainId = child.lastId();
    void connector.inject("u1"); // never answered
    child.respond(mainId, { stopReason: "end_turn" });
    await flush();
    const d = connector.dispose(); // rejects the pending inject
    await expect(outcome).resolves.toBeDefined();
    await d;
    expect(child.signalCode).toBe("SIGTERM");
    expect(child.stdinEnded).toBe(true);
  });

  test("a new prompt on a closed transport rejects instead of starting", async () => {
    const { child, connector } = makeDevin();
    child.emit("exit", 1);
    await expect(
      connector.prompt("late", noActivity, signal()),
    ).rejects.toThrow(/rpc closed/);
  });
});

describe("DevinConnector transport close", () => {
  test("death reports onClosed exactly once across exit, error, and stream close", async () => {
    const closed: string[] = [];
    const { child, connector } = makeDevin((e) => closed.push(e.message));
    child.emit("error", new Error("transport gone"));
    child.emit("exit", 1);
    child.stdout.emit("data", `${"x".repeat(OVER)}\n`);
    await flush();
    expect(closed).toEqual(["transport gone"]);
    await connector.dispose();
  });

  test("an oversized frame rejects a pending prompt and fires onClosed exactly once", async () => {
    const closed: string[] = [];
    const { child, connector } = makeDevin((e) => closed.push(e.message));
    const p = connector.prompt("go", noActivity, signal());
    child.stdout.emit("data", `${"x".repeat(OVER)}\n`);
    await expect(p).rejects.toThrow(/oversized/);
    child.emit("exit", 1);
    await flush();
    expect(closed).toEqual(["rpc stream sent an oversized line"]);
    await connector.dispose();
  });

  test("an oversized peer frame drops the connector via onClosed and closes it", async () => {
    const closed: string[] = [];
    const { child, connector } = makeDevin((e) => closed.push(e.message));
    child.stdout.emit("data", "z".repeat(OVER)); // no newline: unterminated overflow
    await flush();
    expect(closed).toEqual(["rpc stream sent an oversized line"]);
    // A late request frame is never answered after close.
    const before = child.written.length;
    child.stdout.emit("data", `${JSON.stringify({ id: 9, method: "x" })}\n`);
    await flush();
    expect(child.written.length).toBe(before);
    await connector.dispose();
  });

  test("a clean dispose does not call onClosed", async () => {
    const closed: Error[] = [];
    const { child, connector } = makeDevin((e) => closed.push(e));
    await connector.dispose();
    expect(closed).toHaveLength(0);
    expect(child.signalCode).toBe("SIGTERM");
  });
});

describe("DevinConnector permission audit", () => {
  test("allow_once is selected and logged auto_allowed; anything else is cancelled and logged cancelled", async () => {
    const { child, events } = makeDevin();
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        id: 7,
        method: "session/request_permission",
        params: {
          options: [
            { optionId: "o1", kind: "allow_once" },
            { optionId: "o2", kind: "allow_always" },
          ],
        },
      })}\n`,
    );
    await flush();
    expect(child.frames()).toContainEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { outcome: { outcome: "selected", optionId: "o1" } },
    });
    expect(
      events.filter((e) => e.event === "devin.permission.auto_allowed"),
    ).toHaveLength(1);
    expect(
      events.filter((e) => e.event === "devin.permission.cancelled"),
    ).toHaveLength(0);

    child.stdout.emit(
      "data",
      `${JSON.stringify({
        id: 8,
        method: "session/request_permission",
        params: {
          options: [
            { optionId: "r1", kind: "reject_once" },
            { optionId: "a2", kind: "allow_always" },
          ],
        },
      })}\n`,
    );
    await flush();
    expect(child.frames()).toContainEqual({
      jsonrpc: "2.0",
      id: 8,
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(
      events.filter((e) => e.event === "devin.permission.cancelled"),
    ).toHaveLength(1);
    // no false auto_allowed for the request that had no allow_once
    expect(
      events.filter((e) => e.event === "devin.permission.auto_allowed"),
    ).toHaveLength(1);
  });
});

describe("PizConnector transport close", () => {
  test("an oversized frame rejects a turn that session/send already acknowledged, onClosed once", async () => {
    const closed: string[] = [];
    const { child, socket, connector } = makePiz((e) => closed.push(e.message));
    const p = connector.prompt("go", noActivity, signal());
    const sendId = socket.lastId();
    socket.emit("data", `${JSON.stringify({ id: sendId, result: {} })}\n`);
    await flush(); // send acknowledged; the turn itself is still running
    socket.emit("data", `${"q".repeat(OVER)}\n`);
    await expect(p).rejects.toThrow(/oversized/);
    expect(closed).toEqual(["rpc stream sent an oversized line"]);
    // Follow-up exit/close do not fire the callback again.
    socket.emit("close");
    child.emit("exit", 1);
    socket.emit("error", new Error("late"));
    expect(closed).toHaveLength(1);
    // Post-close input never reaches the peer: a request frame goes unanswered.
    const before = socket.written.length;
    socket.emit(
      "data",
      `${JSON.stringify({ id: 9, method: "session/requestRuntimePreferences" })}\n`,
    );
    await flush();
    expect(socket.written.length).toBe(before);
    await connector.dispose();
  });

  test("a clean dispose does not call onClosed and removes the socket dir", async () => {
    const closed: Error[] = [];
    const { socket, connector, socketDir } = makePiz((e) => closed.push(e));
    await connector.dispose();
    expect(closed).toHaveLength(0);
    expect(socket.destroyed).toBe(true);
    expect(existsSync(socketDir)).toBe(false);
  });
});

describe("connectPiz startup", () => {
  const fixture = join(
    mkdtempSync(join(tmpdir(), "fusion-core-fixture-")),
    "fake-core.cjs",
  );
  const previousEnv = process.env.FUSION_PIZ_CORE;

  const withCore = (source: string, fn: () => Promise<void>) => {
    writeFileSync(fixture, source);
    process.env.FUSION_PIZ_CORE = fixture;
    return fn().finally(() => {
      if (previousEnv === undefined) delete process.env.FUSION_PIZ_CORE;
      else process.env.FUSION_PIZ_CORE = previousEnv;
    });
  };

  test("an invalid cwd rejects fast with a wrapped error and cleans the socket dir", () =>
    withCore("setInterval(() => undefined, 1000);", async () => {
      const { events, log } = recordLog();
      const t0 = Date.now();
      await expect(
        connectPiz({
          cwd: "/definitely-not-a-real-dir-fusion",
          model: "GLM-5.3",
          log,
        }),
      ).rejects.toThrow(/piz sidekick failed to start/);
      expect(Date.now() - t0).toBeLessThan(2000);
      const spawned = events.find((e) => e.event === "piz.core.spawned");
      expect(spawned).toBeDefined();
      const socketDir = dirname(String(spawned!.data!.socketPath));
      expect(socketDir).toContain("pi-fusion-");
      expect(existsSync(socketDir)).toBe(false);
    }));

  test("a core that dies by signal fails promptly instead of polling 60s", () =>
    withCore(
      'setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);',
      async () => {
        const { events, log } = recordLog();
        const t0 = Date.now();
        await expect(
          connectPiz({ cwd: "/tmp", model: "GLM-5.3", log }),
        ).rejects.toThrow(
          /piz sidekick failed to start: core killed by signal SIGTERM/,
        );
        expect(Date.now() - t0).toBeLessThan(2000);
        const spawned = events.find((e) => e.event === "piz.core.spawned");
        const socketDir = dirname(String(spawned!.data!.socketPath));
        expect(existsSync(socketDir)).toBe(false);
      },
    ));
});
