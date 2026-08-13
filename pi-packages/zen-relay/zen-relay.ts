#!/usr/bin/env bun
/**
 * zen-relay — all-local multi-IP relay for OpenCode Zen.
 *
 * One process, next to pi. Each request goes to Zen through one of N SOCKS5
 * tunnels (typically `ssh -D` to a gateway server) with that route's Zen key,
 * so Zen sees the gateway's public IP. Round-robins across routes; on a clean
 * 429 cools that route (~60s) and retries on the next; on 5xx/unreachable marks
 * it down (~30s); other 4xx pass through unchanged. If every route is cooling it
 * waits for the soonest revive (≤90s) then retries once.
 *
 * Routes + keys come from env (a mode-600 file loaded by systemd):
 *   ZEN_URL=https://opencode.ai/zen/v1
 *   ROUTE_1_SOCKS=socks5://127.0.0.1:1080   ROUTE_1_KEY=<zen key A>
 *   ROUTE_2_SOCKS=socks5://127.0.0.1:1081   ROUTE_2_KEY=<zen key B>
 *   ... (ROUTE_N_* scanned until a gap)
 *   ROUTE_N_SOCKS may be empty for a direct (no-proxy) route.
 *
 * Keys live only in the env file on this machine. Nothing runs on the gateways
 * beyond an `ssh -D` tunnel. No request bodies or keys are logged.
 */

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { SocksProxyAgent } from "socks-proxy-agent";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PORT = Number(arg("--port") ?? process.env.PORT ?? 4096);
const HOST = arg("--host") ?? process.env.HOST ?? "127.0.0.1";
const ZEN_URL = process.env.ZEN_URL ?? "https://opencode.ai/zen/v1";
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 60_000);
const DOWN_MS = Number(process.env.DOWN_MS ?? 30_000);
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS ?? 90_000);

const jitter = (ms: number) => ms + Math.random() * ms * 0.2;

type Route = {
  label: string; // socks host or "direct"
  agent: SocksProxyAgent | undefined;
  key: string;
  coolingUntil: number; // 429 → leave alone until
  downUntil: number; // 5xx/unreachable → leave alone until
};

const routes: Route[] = [];
for (let i = 1; ; i++) {
  const socks = process.env[`ROUTE_${i}_SOCKS`];
  const key = process.env[`ROUTE_${i}_KEY`];
  if (!socks && !key) break;
  if (!key) {
    console.error(`ROUTE_${i}_SOCKS is set but ROUTE_${i}_KEY is missing`);
    process.exit(2);
  }
  routes.push({
    label: socks ? socks.replace(/^socks5?:\/\//, "") : "direct",
    agent: socks ? new SocksProxyAgent(socks) : undefined,
    key,
    coolingUntil: 0,
    downUntil: 0,
  });
}
if (routes.length === 0) {
  console.error("no ROUTE_*_KEY defined — nothing to route");
  process.exit(2);
}

const zenBase = new URL(ZEN_URL);
const transport = zenBase.protocol === "https:" ? https : http;
const HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "x-forwarded-for",
  "x-real-ip",
  "via",
  "forwarded",
  "te",
  "trailer",
]);

function joinPaths(a: string, b: string): string {
  const s = a.endsWith("/") ? a.slice(0, -1) : a;
  const t = b.startsWith("/") ? b : "/" + b;
  return s + t || "/";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function toOutgoing(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of h.entries()) if (!HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}

function replaceAuth(headers: Record<string, string>, key: string): void {
  // Pi's OpenAI/Responses clients use Authorization; its Anthropic client uses
  // x-api-key. Preserve the incoming auth style while replacing the old pi key
  // with this SOCKS route's account key. Never forward both unrelated keys.
  const usedAuthorization = headers.authorization !== undefined;
  const usedApiKey = headers["x-api-key"] !== undefined;
  delete headers.authorization;
  delete headers["x-api-key"];
  if (usedApiKey) headers["x-api-key"] = key;
  if (usedAuthorization || !usedApiKey) headers.authorization = `Bearer ${key}`;
}

function fromIncoming(h: IncomingMessage["headers"]): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (v == null) continue;
    if (HOP.has(k.toLowerCase())) continue;
    out.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  return out;
}

function doRequest(
  route: Route,
  method: string,
  headers: Record<string, string>,
  body: ArrayBuffer | undefined,
  target: URL,
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      { method, headers, agent: route.agent },
      resolve,
    );
    req.on("error", reject);
    if (signal)
      signal.addEventListener(
        "abort",
        () => req.destroy(new Error("aborted")),
        { once: true },
      );
    req.end(body ?? undefined);
  });
}

function readBody(msg: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    msg.on("data", (c: Buffer) => (b += c.toString()));
    msg.on("end", () => resolve(b));
    msg.on("error", () => resolve(b));
  });
}

let cursor = 0;

async function handle(req: Request): Promise<Response> {
  const start = Date.now();
  const inUrl = new URL(req.url);
  // map the incoming path onto the Zen base; drop a duplicate leading /v1
  let path = inUrl.pathname;
  if (zenBase.pathname.endsWith("/v1") && path.startsWith("/v1"))
    path = path.slice(3) || "/";
  const target = new URL(ZEN_URL);
  target.pathname = joinPaths(zenBase.pathname, path);
  target.search = inUrl.search;

  const body = await req.arrayBuffer(); // buffered so we can replay on retry
  const replay =
    req.method === "GET" || req.method === "HEAD" ? undefined : body;

  const trail: string[] = [];
  let last: { status: number; body: string } | null = null;
  let waited = false;

  while (true) {
    let pick = -1;
    for (let k = 0; k < routes.length; k++) {
      const j = (cursor + k) % routes.length;
      if (Date.now() >= Math.max(routes[j].coolingUntil, routes[j].downUntil)) {
        pick = j;
        break;
      }
    }
    if (pick === -1) {
      const allCooling = routes.every((r) => Date.now() < r.coolingUntil);
      if (allCooling && !waited) {
        waited = true;
        const soonest = Math.min(...routes.map((r) => r.coolingUntil));
        const wait = Math.min(Math.max(0, soonest - Date.now()), MAX_WAIT_MS);
        console.log(
          `[relay] ${req.method} ${inUrl.pathname} all routes cooling — waiting ${Math.round(wait / 1000)}s`,
        );
        await sleep(wait, req.signal);
        continue;
      }
      return new Response(
        last?.body ??
          JSON.stringify({
            error: { message: "zen-relay: all routes unavailable" },
          }),
        {
          status: last?.status ?? 502,
          headers: { "content-type": "application/json" },
        },
      );
    }

    cursor = (pick + 1) % routes.length;
    const route = routes[pick];
    trail.push(route.label);

    let resp: IncomingMessage;
    try {
      const headers = toOutgoing(req.headers);
      replaceAuth(headers, route.key);
      resp = await doRequest(
        route,
        req.method,
        headers,
        replay,
        target,
        req.signal,
      );
    } catch (e) {
      route.downUntil = Date.now() + DOWN_MS;
      console.error(
        `[relay] ${req.method} ${inUrl.pathname} → ${route.label} DOWN (${e})`,
      );
      last = {
        status: 502,
        body: JSON.stringify({
          error: { message: `zen-relay: route ${route.label} unreachable` },
        }),
      };
      continue;
    }

    const status = resp.statusCode ?? 502;
    if (status === 429) {
      const msg = await readBody(resp);
      route.coolingUntil = Date.now() + jitter(COOLDOWN_MS);
      console.log(
        `[relay] ${req.method} ${inUrl.pathname} → ${route.label} 429 (cooling) ${msg.slice(0, 100)}`,
      );
      last = { status: 429, body: msg };
      continue;
    }
    if (status >= 500) {
      const msg = await readBody(resp);
      route.downUntil = Date.now() + DOWN_MS;
      console.log(
        `[relay] ${req.method} ${inUrl.pathname} → ${route.label} ${status} (down) ${msg.slice(0, 100)}`,
      );
      last = { status, body: msg };
      continue;
    }

    // 2xx/3xx, or non-429 4xx → pass through, streaming
    console.log(
      `[relay] ${req.method} ${inUrl.pathname} ${status} ${Date.now() - start}ms via ${trail.join(" → ")}`,
    );
    return new Response(Readable.toWeb(resp) as unknown as BodyInit, {
      status,
      headers: fromIncoming(resp.headers),
    });
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
        role: "relay",
        routes: routes.map((r) => ({
          socks: r.label,
          cooling: r.coolingUntil > now,
          down: r.downUntil > now,
        })),
      });
    }
    try {
      return await handle(req);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError")
        return new Response(null, { status: 499 });
      console.error(`[relay] request failed: ${e}`);
      return Response.json(
        { error: { message: "zen-relay: internal error" } },
        { status: 500 },
      );
    }
  },
});

console.log(
  `[relay] ${HOST}:${PORT} → ${ZEN_URL} via ${routes.length} route(s): ${routes.map((r) => r.label).join(", ")}`,
);
