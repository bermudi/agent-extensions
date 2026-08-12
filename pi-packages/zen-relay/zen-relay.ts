#!/usr/bin/env bun
/**
 * zen-relay — multi-IP relay for OpenCode Zen (or any OpenAI-compatible upstream).
 *
 *   leaf   — runs on each gateway server. Forwards to the upstream with THAT
 *            server's key, so the upstream sees that server's public IP.
 *            One leaf = one quota bucket.
 *   router — runs next to the client (pi). Round-robins across leaves,
 *            retries on 429 with per-leaf cooldown, surfaces errors honestly.
 *
 * Security model:
 *   - Upstream keys live ONLY on leaves (ZEN_API_KEY env), never here.
 *   - Leaves bind to a tailnet IP (--host), never public interfaces.
 *   - Both sides may share a token (SHARED_TOKEN, sent as x-zen-relay-token).
 *   - No bodies, keys, or token values are ever logged.
 */

const HELP = `zen-relay <leaf|router> [--port N] [--host H]

leaf    forwards to the upstream with this server's key
        env:  ZEN_API_KEY   upstream key for THIS server (if unset, the client's
                            Authorization is passed through — keyless mode)
              ZEN_BASE      upstream base URL   (default https://opencode.ai/zen/v1)
              SHARED_TOKEN  require this token from the router
        default: port 8787, host 127.0.0.1  (set --host to the tailnet IP!)

router  round-robins requests across leaves; retries on 429/5xx
        env:  GATEWAYS      comma-separated leaf base URLs (http://<tailnet-ip>:8787)
              SHARED_TOKEN  token to send to leaves (must match them)
              COOLDOWN_MS   leave a 429-ing leaf alone   (default 60000)
              DOWN_MS       leave a failing leaf alone   (default 30000)
              MAX_WAIT_MS   max wait for a cooling leaf  (default 90000)
        default: port 4096, host 127.0.0.1
`;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mode = process.argv[2];
if (mode !== "leaf" && mode !== "router") {
  console.error(HELP);
  process.exit(2);
}

const DEFAULT_PORT = mode === "leaf" ? 8787 : 4096;
const PORT = Number(arg("--port") ?? process.env.PORT ?? DEFAULT_PORT);
const TOKEN = process.env.SHARED_TOKEN;

/** Headers that must never cross a hop (or that we manage ourselves). */
const HOP = new Set([
  "host", "connection", "content-length", "transfer-encoding", "keep-alive",
  "upgrade", "proxy-connection", "x-forwarded-for", "x-real-ip", "via",
  "forwarded", "te", "trailer",
]);

function cleanHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of headers) {
    const lk = k.toLowerCase();
    if (!HOP.has(lk) && !lk.startsWith("x-zen-relay-")) out.append(k, v);
  }
  return out;
}

function joinPaths(a: string, b: string): string {
  const s = a.endsWith("/") ? a.slice(0, -1) : a;
  const t = b.startsWith("/") ? b : "/" + b;
  return (s + t) || "/";
}

function joinUrl(base: string, path: string, search: string): string {
  const u = new URL(base);
  u.pathname = joinPaths(u.pathname, path);
  u.search = search;
  return u.toString();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

function requiresToken(req: Request): Response | null {
  if (TOKEN && req.headers.get("x-zen-relay-token") !== TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* leaf                                                                */
/* ------------------------------------------------------------------ */

if (mode === "leaf") {
  const ZEN_BASE = process.env.ZEN_BASE ?? "https://opencode.ai/zen/v1";
  const MY_KEY = process.env.ZEN_API_KEY;
  const HOST = arg("--host") ?? process.env.HOST ?? "127.0.0.1";

  let cached: { ip: string; at: number } = { ip: "", at: 0 };

  Bun.serve({
    port: PORT,
    hostname: HOST,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz") {
        const denied = requiresToken(req);
        if (denied) return denied;
        if (Date.now() - cached.at > 60_000) {
          let ip = "";
          try {
            const r = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(5000) });
            ip = (await r.text()).trim();
          } catch { /* keep last known */ }
          cached = { ip, at: Date.now() };
        }
        return Response.json({ ok: true, role: "leaf", publicIp: cached.ip });
      }

      const denied = requiresToken(req);
      if (denied) return denied;

      const base = new URL(ZEN_BASE);
      let path = url.pathname;
      // The router may pass paths that already start with /v1 (mirroring the
      // upstream base); drop the duplicate so ZEN_BASE stays an exact prefix.
      if (base.pathname.endsWith("/v1") && path.startsWith("/v1")) path = path.slice(3) || "/";
      const upstream = joinUrl(ZEN_BASE, path, url.search);

      const headers = cleanHeaders(req.headers);
      if (MY_KEY) headers.set("authorization", `Bearer ${MY_KEY}`);

      try {
        // Buffer the request body before touching the upstream. The upstream may
        // answer early (429, fast error) without consuming the body; responding
        // before the request is fully drained leaves this connection in a state
        // where Bun.serve misreads the NEXT request as leftover body and answers
        // spurious 400s. Buffering keeps the keep-alive connection clean.
        const raw = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
        const res = await fetch(upstream, {
          method: req.method,
          headers,
          body: raw,
          redirect: "manual",
          signal: req.signal,
        });
        const out = new Headers();
        for (const [k, v] of res.headers) if (!HOP.has(k.toLowerCase())) out.set(k, v);
        return new Response(res.body, { status: res.status, headers: out });
      } catch (e) {
        console.error(`[leaf] upstream unreachable: ${e}`);
        return Response.json(
          { error: { message: "zen-relay leaf: upstream unreachable" } },
          { status: 502 },
        );
      }
    },
  });

  console.log(`[leaf] ${HOST}:${PORT} → ${ZEN_BASE}${MY_KEY ? " (this server's key)" : " (passing client Authorization)"}`);
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

else {
  const GATEWAYS = (process.env.GATEWAYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (GATEWAYS.length === 0) {
    console.error("[router] GATEWAYS is empty — nothing to route to");
    process.exit(2);
  }
  const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 60_000);
  const DOWN_MS = Number(process.env.DOWN_MS ?? 30_000);
  const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS ?? 90_000);
  const HOST = arg("--host") ?? process.env.HOST ?? "127.0.0.1";
  const jitter = (ms: number) => ms + Math.random() * ms * 0.2;

  const state = GATEWAYS.map((base) => ({
    base,
    coolingUntil: 0, // 429 → leave alone until this time
    downUntil: 0,    // 5xx/unreachable → leave alone until this time
  }));
  let cursor = 0;

  /** Healthy gateway indexes, rotation starting after the last pick. */
  function healthy(): number[] {
    const idx: number[] = [];
    for (let i = 0; i < state.length; i++) {
      const j = (cursor + i) % state.length;
      const g = state[j];
      if (Date.now() >= Math.max(g.coolingUntil, g.downUntil)) idx.push(j);
    }
    return idx;
  }

  async function handle(req: Request): Promise<Response> {
    const start = Date.now();
    const url = new URL(req.url);
    const body = await req.arrayBuffer(); // buffered so we can replay on retry
    const replay = req.method === "GET" || req.method === "HEAD" ? undefined : body;

    const trail: string[] = [];
    let last: { status: number; body: string } | null = null;
    let waited = false;

    while (true) {
      const idx = healthy();
      if (idx.length === 0) {
        const allCooling = state.every((g) => Date.now() < g.coolingUntil);
        if (allCooling && !waited) {
          // Every bucket is cooling: wait for the soonest revive, then retry once.
          waited = true;
          const soonest = Math.min(...state.map((g) => g.coolingUntil));
          const wait = Math.min(Math.max(0, soonest - Date.now()), MAX_WAIT_MS);
          console.log(`[router] ${req.method} ${url.pathname} all leaves cooling — waiting ${Math.round(wait / 1000)}s`);
          await sleep(wait, req.signal);
          continue;
        }
        return new Response(
          last?.body ?? JSON.stringify({ error: { message: "zen-relay: all gateways unavailable" } }),
          { status: last?.status ?? 502, headers: { "content-type": "application/json" } },
        );
      }

      const gw = state[idx[0]];
      cursor = (idx[0] + 1) % state.length;
      trail.push(gw.base);

      let res: Response;
      try {
        res = await fetch(joinUrl(gw.base, url.pathname, url.search), {
          method: req.method,
          headers: (() => {
            const h = cleanHeaders(req.headers);
            if (TOKEN) h.set("x-zen-relay-token", TOKEN);
            return h;
          })(),
          body: replay,
          redirect: "manual",
          signal: req.signal,
        });
      } catch (e) {
        gw.downUntil = Date.now() + DOWN_MS;
        console.error(`[router] ${req.method} ${url.pathname} → ${gw.base} DOWN (${e})`);
        last = { status: 502, body: JSON.stringify({ error: { message: `zen-relay: gateway ${gw.base} unreachable` } }) };
        continue;
      }

      if (res.status === 429) {
        const msg = await res.text().catch(() => "");
        gw.coolingUntil = Date.now() + jitter(COOLDOWN_MS);
        console.log(`[router] ${req.method} ${url.pathname} → ${gw.base} 429 (cooling) ${msg.slice(0, 100)}`);
        last = { status: 429, body: msg };
        continue;
      }

      if (res.status >= 500) {
        const msg = await res.text().catch(() => String(res.status));
        gw.downUntil = Date.now() + DOWN_MS;
        console.log(`[router] ${req.method} ${url.pathname} → ${gw.base} ${res.status} (down) ${msg.slice(0, 100)}`);
        last = { status: res.status, body: msg };
        continue;
      }

      // 2xx/3xx, or 4xx (non-429) — pass through as-is, do not rotate.
      const out = new Headers();
      for (const [k, v] of res.headers) if (!HOP.has(k.toLowerCase())) out.set(k, v);
      console.log(`[router] ${req.method} ${url.pathname} ${res.status} ${Date.now() - start}ms via ${trail.join(" → ")}`);
      return new Response(res.body, { status: res.status, headers: out });
    }
  }

  Bun.serve({
    port: PORT,
    hostname: HOST,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        const now = Date.now();
        return Response.json({
          ok: true,
          role: "router",
          gateways: state.map((g) => ({
            base: g.base,
            cooling: g.coolingUntil > now,
            down: g.downUntil > now,
          })),
        });
      }
      try {
        return await handle(req);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          return new Response(null, { status: 499 }); // client went away
        }
        console.error(`[router] request failed: ${e}`);
        return Response.json({ error: { message: "zen-relay: internal error" } }, { status: 500 });
      }
    },
  });

  console.log(`[router] ${HOST}:${PORT} → ${GATEWAYS.join(", ")} (cooldown ${COOLDOWN_MS}ms, down ${DOWN_MS}ms)`);
}