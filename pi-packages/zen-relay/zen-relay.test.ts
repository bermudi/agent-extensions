import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";

/**
 * End-to-end test of the all-local relay: a mock Zen (429 per key) reached
 * through per-route SOCKS5 mock tunnels. Verifies:
 *   1. 429 on first route → retried on second → streamed 200, route A cooling
 *   2. cooling route is skipped on subsequent requests
 *   3. all routes cooling → waits for the soonest revive, then 429 honestly
 *   4. 5xx → route marked down, retried elsewhere, recovers
 *   5. other 4xx (401) → passed through, NO rotation
 *   6. /healthz reports route states
 */

const KEYS = { A: "mock-key-A", B: "mock-key-B" };
const counts = { A: 0, B: 0 };
const authSeen: Array<{ authorization?: string; apiKey?: string }> = [];
let both429 = false,
  a500 = false,
  a401 = false;

function sse(content: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/* ---------- mock Zen ---------- */
const mockApp = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/v1/models") {
    res.end(JSON.stringify({ data: [{ id: "zen" }] }));
    return;
  }
  authSeen.push({
    ...(req.headers.authorization
      ? { authorization: req.headers.authorization }
      : {}),
    ...(typeof req.headers["x-api-key"] === "string"
      ? { apiKey: req.headers["x-api-key"] }
      : {}),
  });
  const key = (
    req.headers.authorization ??
    req.headers["x-api-key"] ??
    ""
  ).slice(-5);
  const which =
    key === KEYS.A.slice(-5) ? "A" : key === KEYS.B.slice(-5) ? "B" : null;
  if (which) counts[which as "A" | "B"] += 1;
  if (which && a401) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad key" } }));
    return;
  }
  if (which === "A" && a500) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "boom" } }));
    return;
  }
  const would429 = which === "A" || (which === "B" && both429);
  if (would429) {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "FreeUsageLimitError",
        message: "Rate limit exceeded. Please try again later.",
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(sse("mock-chunk-1"));
  res.write(sse("mock-chunk-2"));
  res.write("data: [DONE]\n\n");
  res.end();
});

/* ---------- SOCKS5 mock tunnel (no-auth CONNECT, relays anywhere) ---------- */
function startSocks(port: number): Promise<net.Server> {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.once("data", () => {
        sock.write(Buffer.from([5, 0])); // no-auth ack
        sock.once("data", (req) => {
          const atyp = req[3];
          let host = "",
            port = 0;
          if (atyp === 1) {
            host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
            port = req.readUInt16BE(8);
          } else if (atyp === 3) {
            const len = req[4];
            host = req.subarray(5, 5 + len).toString();
            port = req.readUInt16BE(5 + len);
          } else {
            sock.end();
            return;
          }
          const target = net.connect(port, host);
          target.on("connect", () => {
            sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            sock.pipe(target);
            target.pipe(sock);
          });
          target.on("error", () => sock.end());
        });
      });
    });
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

/* ---------- free-port selection (avoid colliding with real services) ---------- */
async function pickBase(): Promise<number> {
  const free = (port: number) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve(false);
      });
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

const BASE = await pickBase();
const P_ZEN = BASE,
  P_SA = BASE + 1,
  P_SB = BASE + 2;
const P_R1 = BASE + 10,
  P_R2 = BASE + 11,
  P_R3 = BASE + 12;

await new Promise<void>((r) => mockApp.listen(P_ZEN, "127.0.0.1", r));
const socksA = await startSocks(P_SA);
const socksB = await startSocks(P_SB);

const LOGDIR = mkdtempSync(join(tmpdir(), "zen-relay-test-"));
const procs: ReturnType<typeof Bun.spawn>[] = [];

function runRelay(port: number, extra: Record<string, string>) {
  const p = Bun.spawn(
    [
      process.execPath,
      "run",
      "zen-relay.ts",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
    ],
    {
      env: {
        ...process.env,
        ZEN_URL: `http://127.0.0.1:${P_ZEN}`,
        ROUTE_1_SOCKS: `socks5://127.0.0.1:${P_SA}`,
        ROUTE_1_KEY: KEYS.A,
        ROUTE_2_SOCKS: `socks5://127.0.0.1:${P_SB}`,
        ROUTE_2_KEY: KEYS.B,
        ...extra,
      },
      stdout: "ignore",
      stderr: Bun.file(join(LOGDIR, `relay-${port}.log`)),
    },
  );
  procs.push(p);
}

async function waitHealth(port: number, what: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  throw new Error(`healthz never came up: ${what}`);
}

type Health = {
  role: string;
  routes: Array<{ socks: string; cooling: boolean; down: boolean }>;
};

async function healthz(port: number): Promise<Health> {
  return (
    await fetch(`http://127.0.0.1:${port}/healthz`)
  ).json() as Promise<Health>;
}

async function flag(f: Record<string, boolean>) {
  // flags live in this process's module scope, so they take effect immediately
  for (const [k, v] of Object.entries(f)) {
    if (k === "both429") both429 = v;
    if (k === "a500") a500 = v;
    if (k === "a401") a401 = v;
  }
}

const chat = {
  model: "zen",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
};

runRelay(P_R1, {}); // 30s cooldown
runRelay(P_R2, { COOLDOWN_MS: "400", MAX_WAIT_MS: "3000" }); // fast revive
runRelay(P_R3, { DOWN_MS: "400" });

test("setup: relays healthy", async () => {
  await Promise.all([
    waitHealth(P_R1, "relay1"),
    waitHealth(P_R2, "relay2"),
    waitHealth(P_R3, "relay3"),
  ]);
});

test("1: 429 on first route → retried on second, streamed 200, A cooling", async () => {
  const r = await fetch(`http://127.0.0.1:${P_R1}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chat),
  });
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).toContain("mock-chunk-1");
  expect(counts).toEqual({ A: 1, B: 1 });
  const hz = await healthz(P_R1);
  expect(hz.routes[0].cooling).toBe(true);
  expect(hz.routes[1].cooling).toBe(false);
});

test("2: cooling route is skipped; non-stream GET passes through", async () => {
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

test("3: Anthropic x-api-key is replaced without leaking pi's old key", async () => {
  const before = authSeen.length;
  const r = await fetch(`http://127.0.0.1:${P_R1}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "old-pi-key" },
    body: JSON.stringify({
      model: "zen",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  expect(r.status).toBe(200);
  const seen = authSeen.slice(before);
  expect(seen.length).toBe(1);
  expect(seen[0]).toEqual({ apiKey: KEYS.B });
});

test("4: all routes cooling → waits for soonest revive, then 429 honestly", async () => {
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
  expect(elapsed).toBeGreaterThan(250);
  expect(elapsed).toBeLessThan(15000);
  await flag({ both429: false });
});

test("5: 5xx → route marked down, retried elsewhere, recovers", async () => {
  await flag({ a500: true });
  const r = await fetch(`http://127.0.0.1:${P_R3}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chat),
  });
  expect(r.status).toBe(200);
  const hz = await healthz(P_R3);
  expect(hz.routes[0].down).toBe(true);
  await flag({ a500: false });
  await Bun.sleep(600);
  const r2 = await fetch(`http://127.0.0.1:${P_R3}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chat),
  });
  expect(r2.status).toBe(200);
});

test("6: non-429 4xx passes through without rotation", async () => {
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
  expect(totalDelta).toBe(1); // exactly one route tried — no rotation on 4xx
  await flag({ a401: false });
});

test("7: /healthz reports route states", async () => {
  const hz = await healthz(P_R1);
  expect(hz.role).toBe("relay");
  expect(hz.routes.length).toBe(2);
  for (const r of hz.routes) expect(typeof r.socks).toBe("string");
});

afterAll(() => {
  for (const name of readdirSync(LOGDIR)) {
    const body = readFileSync(join(LOGDIR, name), "utf8").trim();
    if (body) console.log(`--- ${name} ---\n${body}`);
  }
  for (const p of procs) p.kill();
  socksA.close();
  socksB.close();
  mockApp.close();
});
