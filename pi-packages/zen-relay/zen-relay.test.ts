import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end test: mock Zen (429 per key) + two leaves (different keys) +
 * routers with different policies. Verifies:
 *   1. 429 on first leaf → retry on second → streamed 200, leaf A cooling
 *   2. cooling leaf is skipped on subsequent requests
 *   3. all leaves cooling → router waits for the soonest revive, then 429 honestly
 *   4. 5xx → leaf marked down, retried elsewhere, recovers
 *   5. other 4xx (401) → passed through, NO rotation
 *   6. leaf requires the shared token
 */

async function pickBase(): Promise<number> {
  const net = await import("node:net");
  const free = (port: number) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.destroy(); resolve(false); });
      s.once("error", () => resolve(true));
    });
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 20000);
    const ports = [base, base + 1, base + 2, base + 10, base + 11, base + 12];
    const all = await Promise.all(ports.map(free));
    if (all.every(Boolean)) return base;
  }
  throw new Error("could not find 6 free ports");
}

const BASE = await pickBase(); // avoid colliding with real services (e.g. cloudflared :20241)
const P_MOCK = BASE, P_LA = BASE + 1, P_LB = BASE + 2;
const P_R1 = BASE + 10, P_R2 = BASE + 11, P_R3 = BASE + 12;
const BUN = process.execPath;
const SCRIPT = join(import.meta.dir, "zen-relay.ts");

const KEYS = { A: "mock-key-A", B: "mock-key-B" };
const counts = { A: 0, B: 0 };
let both429 = false, a500 = false, a401 = false;

/* ---------- mock upstream ---------- */

function sse(content: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

const mock = Bun.serve({
  port: P_MOCK,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/_flag") {
      const f = (await req.json()) as Record<string, boolean>;
      if (typeof f.both429 === "boolean") both429 = f.both429;
      if (typeof f.a500 === "boolean") a500 = f.a500;
      if (typeof f.a401 === "boolean") a401 = f.a401;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/_counts") return Response.json(counts);
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "zen" }] });

    const key = req.headers.get("authorization") ?? "";
    if (!key) return Response.json({ error: "no auth" }, { status: 401 });
    const which = key.endsWith(KEYS.A) ? "A" : key.endsWith(KEYS.B) ? "B" : null;
    counts[which as "A" | "B"] += 1;

    if (a401) return Response.json({ error: { message: "bad key" } }, { status: 401 });
    if (which === "A" && a500) return Response.json({ error: { message: "boom" } }, { status: 500 });

    const would429 = which === "A" || (which === "B" && both429);
    if (would429) {
      return Response.json(
        { type: "FreeUsageLimitError", message: "Rate limit exceeded. Please try again later." },
        { status: 429 },
      );
    }

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(sse("mock-chunk-1")));
        c.enqueue(enc.encode(sse("mock-chunk-2")));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});

/* ---------- helpers ---------- */

const LOGDIR = mkdtempSync(join(tmpdir(), "zen-relay-test-"));
const procs: ReturnType<typeof Bun.spawn>[] = [];

function runLeaf(port: number, key: string) {
  const p = Bun.spawn(
    [BUN, "run", SCRIPT, "leaf", "--port", String(port), "--host", "127.0.0.1"],
    {
      env: {
        ...process.env,
        ZEN_API_KEY: key,
        ZEN_BASE: `http://127.0.0.1:${P_MOCK}`,
        SHARED_TOKEN: "test",
      },
      stdout: "ignore",
      stderr: Bun.file(join(LOGDIR, `leaf-${port}.log`)),
    },
  );
  procs.push(p);
  return p;
}

function runRouter(port: number, extra: Record<string, string>) {
  const p = Bun.spawn(
    [BUN, "run", SCRIPT, "router", "--port", String(port), "--host", "127.0.0.1"],
    {
      env: {
        ...process.env,
        GATEWAYS: `http://127.0.0.1:${P_LA},http://127.0.0.1:${P_LB}`,
        SHARED_TOKEN: "test",
        ...extra,
      },
      stdout: "ignore",
      stderr: Bun.file(join(LOGDIR, `router-${port}.log`)),
    },
  );
  procs.push(p);
  return p;
}

async function waitHealth(port: number, what: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
        headers: { "x-zen-relay-token": "test" },
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await Bun.sleep(150);
  }
  throw new Error(`healthz never came up: ${what}`);
}

const chat = {
  model: "zen",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
};

async function healthz(port: number) {
  return (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as any;
}

async function flag(f: Record<string, boolean>) {
  await fetch(`http://127.0.0.1:${P_MOCK}/_flag`, { method: "POST", body: JSON.stringify(f) });
}

/* ---------- scope ---------- */

runLeaf(P_LA, KEYS.A);
runLeaf(P_LB, KEYS.B);
runRouter(P_R1, {});                                       // 30s cooldown
runRouter(P_R2, { COOLDOWN_MS: "400", MAX_WAIT_MS: "3000" }); // fast revive
runRouter(P_R3, { DOWN_MS: "400" });

test("setup: all processes healthy", async () => {
  await Promise.all([
    waitHealth(P_LA, "leaf A"),
    waitHealth(P_LB, "leaf B"),
    waitHealth(P_R1, "router 1"),
    waitHealth(P_R2, "router 2"),
    waitHealth(P_R3, "router 3"),
  ]);
}, 30000);

test("1: 429 on first leaf → retried on second, streamed 200, A cooling", async () => {
  const r = await fetch(`http://127.0.0.1:${P_R1}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chat),
  });
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).toContain("mock-chunk-1");
  expect(text).toContain("mock-chunk-2");

  expect(counts).toEqual({ A: 1, B: 1 });
  const hz = await healthz(P_R1);
  expect(hz.gateways[0].cooling).toBe(true); // A 429ed → cooling
  expect(hz.gateways[1].cooling).toBe(false);
});

test("2: cooling leaf is skipped; non-stream GET passes through", async () => {
  const r = await fetch(`http://127.0.0.1:${P_R1}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chat),
  });
  expect(r.status).toBe(200);
  expect(counts).toEqual({ A: 1, B: 2 }); // A untouched

  const m = await fetch(`http://127.0.0.1:${P_R1}/v1/models`);
  expect(await m.json()).toEqual({ data: [{ id: "zen" }] });
});

test("3: all leaves cooling → waits for soonest revive, then 429 honestly", async () => {
  await flag({ both429: true });
  const start = Date.now();
  const r = await fetch(`http://127.0.0.1:${P_R2}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chat),
  });
  const elapsed = Date.now() - start;
  expect(r.status).toBe(429);
  expect(await r.text()).toContain("FreeUsageLimitError");
  expect(elapsed).toBeGreaterThan(250); // really waited for a revive
  expect(elapsed).toBeLessThan(15000);
  await flag({ both429: false });
});

test("4: 5xx → leaf marked down, retried elsewhere, recovers", async () => {
  await flag({ a500: true });
  const r = await fetch(`http://127.0.0.1:${P_R3}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chat),
  });
  expect(r.status).toBe(200);
  const hz = await healthz(P_R3);
  expect(hz.gateways[0].down).toBe(true);
  expect(hz.gateways[1].down).toBe(false);

  await flag({ a500: false });
  await Bun.sleep(600);
  const r2 = await fetch(`http://127.0.0.1:${P_R3}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chat),
  });
  expect(r2.status).toBe(200); // A recovered
});

test("5: non-429 4xx passes through without rotation", async () => {
  await flag({ a401: true });
  const before = { ...counts };
  const r = await fetch(`http://127.0.0.1:${P_R3}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chat),
  });
  expect(r.status).toBe(401);
  const after = { ...counts };
  const totalDelta = after.A - before.A + (after.B - before.B);
  expect(totalDelta).toBe(1); // exactly one gateway tried — no rotation on 4xx
  await flag({ a401: false });
});

test("6: leaf enforces the shared token", async () => {
  const denied = await fetch(`http://127.0.0.1:${P_LA}/healthz`);
  expect(denied.status).toBe(403);
  const ok = await fetch(`http://127.0.0.1:${P_LA}/healthz`, {
    headers: { "x-zen-relay-token": "test" },
  });
  expect(ok.status).toBe(200);
  expect((await ok.json()).role).toBe("leaf");
});

afterAll(() => {
  const logs = readdirSync(LOGDIR);
  for (const name of logs) {
    const body = readFileSync(join(LOGDIR, name), "utf8").trim();
    if (body) console.log(`--- ${name} ---\n${body}`);
  }
  mock.stop();
  for (const p of procs) p.kill();
});
