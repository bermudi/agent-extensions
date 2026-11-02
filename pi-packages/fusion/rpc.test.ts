import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { RpcError, RpcPeer, stopChild, withDeadline } from "./rpc.ts";

function pair(jsonrpc: boolean) {
  const out: Record<string, unknown>[] = [];
  const peer = new RpcPeer({
    jsonrpc,
    idPrefix: "t",
    write: (line) => out.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { peer, out };
}

describe("RpcPeer", () => {
  test("request/response correlation; jsonrpc field only when asked", async () => {
    const acp = pair(true);
    const p = acp.peer.request("initialize", { v: 1 });
    expect(acp.out[0]).toEqual({
      jsonrpc: "2.0",
      id: "t-1",
      method: "initialize",
      params: { v: 1 },
    });
    acp.peer.feed(
      `${JSON.stringify({ jsonrpc: "2.0", id: "t-1", result: { ok: true } })}\n`,
    );
    expect(await p).toEqual({ ok: true });

    const zc = pair(false);
    void zc.peer.request("session/create", {});
    expect(zc.out[0]).not.toHaveProperty("jsonrpc");
  });

  test("error responses reject with RpcError carrying the code", async () => {
    const { peer } = pair(false);
    const p = peer.request("x");
    peer.feed(
      `${JSON.stringify({ id: "t-1", error: { code: -32601, message: "nope" } })}\n`,
    );
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32601);
  });

  test("frames split across chunks are reassembled", async () => {
    const { peer } = pair(false);
    const p = peer.request("x");
    const line = `${JSON.stringify({ id: "t-1", result: 42 })}\n`;
    peer.feed(line.slice(0, 5));
    peer.feed(line.slice(5));
    expect(await p).toBe(42);
  });

  test("server->client requests are answered; unknown methods get -32601", async () => {
    const { peer, out } = pair(false);
    peer.setRequestHandler(async (method) => {
      if (method === "known") return { yes: 1 };
      throw new RpcError(-32601, "unknown");
    });
    peer.feed(`${JSON.stringify({ id: 7, method: "known", params: {} })}\n`);
    peer.feed(`${JSON.stringify({ id: 8, method: "other" })}\n`);
    await new Promise((r) => setTimeout(r, 0));
    expect(out).toContainEqual({ id: 7, result: { yes: 1 } });
    expect(out).toContainEqual({
      id: 8,
      error: { code: -32601, message: "unknown" },
    });
  });

  test("notifications reach handlers; garbage lines are dropped", () => {
    const { peer } = pair(false);
    const seen: string[] = [];
    peer.onNotification((m) => seen.push(m));
    peer.feed("not json\n");
    peer.feed(
      `${JSON.stringify({ method: "session/rawEvent", params: {} })}\n`,
    );
    expect(seen).toEqual(["session/rawEvent"]);
  });

  test("close rejects pending requests and refuses new ones", async () => {
    const { peer } = pair(false);
    const p = peer.request("x");
    peer.close(new Error("gone"));
    await expect(p).rejects.toThrow("gone");
    await expect(peer.request("y")).rejects.toThrow(/rpc closed/);
  });

  const OVER = 8 * 1024 * 1024 + 1;

  test("an unterminated oversized fragment closes the peer once", async () => {
    const closes: string[] = [];
    const peer = new RpcPeer({
      jsonrpc: false,
      idPrefix: "t",
      write: () => undefined,
      onClose: (r) => closes.push(r.message),
    });
    const p = peer.request("x");
    peer.feed("x".repeat(OVER));
    expect(closes).toEqual(["rpc stream sent an oversized line"]);
    await expect(p).rejects.toThrow(/oversized/);
    peer.close(new Error("again")); // idempotent
    expect(closes).toHaveLength(1);
  });

  test("a complete oversized line closes the peer without dispatching it", () => {
    const seen: string[] = [];
    const closes: string[] = [];
    const peer = new RpcPeer({
      jsonrpc: false,
      idPrefix: "t",
      write: () => undefined,
      onClose: (r) => closes.push(r.message),
    });
    peer.onNotification((m) => seen.push(m));
    peer.feed(
      `${JSON.stringify({ method: "big", params: { d: "x".repeat(OVER) } })}\n`,
    );
    expect(seen).toHaveLength(0);
    expect(closes).toEqual(["rpc stream sent an oversized line"]);
  });

  test("a normal frame followed by an oversized trailing fragment dispatches then closes", () => {
    const seen: string[] = [];
    const closes: string[] = [];
    const peer = new RpcPeer({
      jsonrpc: false,
      idPrefix: "t",
      write: () => undefined,
      onClose: (r) => closes.push(r.message),
    });
    peer.onNotification((m) => seen.push(m));
    peer.feed(
      `${JSON.stringify({ method: "ok", params: {} })}\n${"y".repeat(OVER)}`,
    );
    expect(seen).toEqual(["ok"]);
    expect(closes).toEqual(["rpc stream sent an oversized line"]);
  });

  test("after close: feed ignores everything, buffered frames are dropped, onClose fires once", () => {
    const seen: string[] = [];
    const closes: string[] = [];
    const peer = new RpcPeer({
      jsonrpc: false,
      idPrefix: "t",
      write: () => undefined,
      onClose: (r) => closes.push(r.message),
    });
    peer.onNotification((m) => seen.push(m));
    // Buffer a partial line, then close mid-stream.
    peer.feed(JSON.stringify({ method: "late", params: {} }));
    peer.close(new Error("shutdown"));
    expect(closes).toEqual(["shutdown"]);
    // The buffered frame is never dispatched, and new input is ignored.
    peer.feed(`\n${JSON.stringify({ method: "later", params: {} })}\n`);
    expect(seen).toHaveLength(0);
    peer.close(new Error("twice"));
    expect(closes).toHaveLength(1);
    expect(peer.isClosed).toBe(true);
  });

  test("a handler that closes the peer stops dispatch of the remaining buffer", () => {
    const seen: string[] = [];
    const peer = new RpcPeer({
      jsonrpc: false,
      idPrefix: "t",
      write: () => undefined,
    });
    peer.onNotification((m) => {
      seen.push(m);
      peer.close(new Error("stop"));
    });
    peer.feed(
      `${JSON.stringify({ method: "first" })}\n${JSON.stringify({ method: "second" })}\n`,
    );
    expect(seen).toEqual(["first"]);
  });
});

describe("withDeadline", () => {
  test("rejects a handshake that never answers", async () => {
    await expect(
      withDeadline(new Promise(() => undefined), 20, "start"),
    ).rejects.toThrow(/start timed out/);
  });
  test("passes the value through when in time", async () => {
    expect(await withDeadline(Promise.resolve(5), 1000, "x")).toBe(5);
  });
});

describe("stopChild", () => {
  test("returns at once for a child already killed by a signal (no 3s SIGKILL wait)", async () => {
    const child = spawn("sleep", ["30"]);
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGKILL");
    const t0 = Date.now();
    await stopChild(child);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  test("terminates a live child", async () => {
    const child = spawn("sleep", ["30"]);
    await stopChild(child);
    expect(child.signalCode ?? child.exitCode).not.toBeNull();
  });
});
