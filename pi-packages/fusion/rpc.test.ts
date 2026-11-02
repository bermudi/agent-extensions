import { describe, expect, test } from "bun:test";
import { RpcError, RpcPeer } from "./rpc.ts";

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
});
