/**
 * Live smoke check for the Kilo provider against the real gateway.
 *
 * Run before publishing goodies, or whenever kilo misbehaves:
 *   cd pi-packages/bermudis-pi-goodies && bun run kilo-smoke
 *
 * Anonymous by design: it exercises exactly the surface an unauthenticated
 * pi sees — the public catalog plus this package's own production mapping
 * code. It never touches the device-auth endpoint (no pending codes, no rate
 * limit burn). Exit 0 = the catalog still maps cleanly; non-zero = the
 * gateway or metadata schema drifted and kilo.ts needs a look. DRIFT lines
 * are informational: they flag that kilo.ts's hardcoded knowledge (Responses
 * routing metadata, anthropic cache control, :free conventions) may need a
 * review, without blocking on it.
 */
import {
  mapOpenRouterModel,
  shouldUseResponsesApi,
  type OpenRouterModel,
} from "../kilo.ts";

const BASE = (process.env.KILO_API_URL ?? "https://api.kilo.ai").replace(
  /\/+$/,
  "",
);

const failures: string[] = [];
const drift: string[] = [];

function check(ok: boolean, message: string): boolean {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
  return ok;
}

const response = await fetch(`${BASE}/api/gateway/models`, {
  headers: { "User-Agent": "pi-kilo-smoke" },
  signal: AbortSignal.timeout(20_000),
});

if (!check(response.ok, `GET /api/gateway/models -> HTTP ${response.status}`)) {
  process.exit(1);
}

const json = (await response.json()) as { data?: unknown };
const catalog = Array.isArray(json.data)
  ? (json.data as OpenRouterModel[])
  : [];
check(
  catalog.length >= 100,
  `catalog contains ${catalog.length} models (floor: 100)`,
);

// Run every entry through the production mapper: this is the actual code pi
// executes, so schema drift fails here first instead of in a user session.
const mappedOk: OpenRouterModel[] = [];
const ids = new Set<string>();
let duplicates = 0;

for (const entry of catalog) {
  const rawId = typeof entry.id === "string" && entry.id ? entry.id : "<no id>";
  try {
    const config = mapOpenRouterModel(entry);
    if (!config.id) {
      failures.push(`${rawId}: mapped without an id`);
      continue;
    }
    if (ids.has(config.id)) duplicates++;
    ids.add(config.id);
    if (!config.name) failures.push(`${rawId}: mapped without a name`);
    if (!Number.isFinite(config.contextWindow) || config.contextWindow <= 0) {
      failures.push(
        `${rawId}: bad contextWindow ${String(config.contextWindow)}`,
      );
    }
    if (!Number.isFinite(config.maxTokens) || config.maxTokens <= 0) {
      failures.push(`${rawId}: bad maxTokens ${String(config.maxTokens)}`);
    }
    const cost = config.cost;
    if (
      !cost ||
      [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].some(
        (value) => !Number.isFinite(value) || value < 0,
      )
    ) {
      failures.push(`${rawId}: bad cost fields`);
    }
    mappedOk.push(entry);
  } catch (error) {
    failures.push(`${rawId}: mapOpenRouterModel threw ${String(error)}`);
  }
}

check(
  mappedOk.length === catalog.length,
  `all ${catalog.length} entries map through mapOpenRouterModel (${failures.filter((f) => f.includes("threw")).length} threw)`,
);
check(duplicates === 0, `model ids unique (${duplicates} duplicates)`);

// Drift notes: informational, reviewed by a human before publishing.
const withOpencode = catalog.filter((m) => m.opencode).length;
if (withOpencode === 0) {
  drift.push("no model carries an `opencode` metadata block — schema changed?");
}
const responsesTagged = catalog.filter(
  (m) => m.opencode?.ai_sdk_provider === "openai",
).length;
if (responsesTagged === 0) {
  drift.push(
    "no model tagged ai_sdk_provider=openai — Responses-API routing metadata missing",
  );
}
const anthropicCount = catalog.filter((m) =>
  m.id?.startsWith("anthropic/"),
).length;
if (anthropicCount === 0) {
  drift.push("no anthropic/* models — cache-control compat path may be dead");
}
const freeCount = catalog.filter((m) => m.id?.includes(":free")).length;
if (freeCount === 0) {
  drift.push("no :free models in catalog (bootstrap router unaffected)");
}

const responsesRouted = mappedOk.filter(
  (m) => typeof m.id === "string" && shouldUseResponsesApi(m),
).length;
const variantsCount = catalog.filter((m) => m.opencode?.variants).length;

for (const note of drift) console.log(`DRIFT ${note}`);
console.log(
  `info responses-tagged: ${responsesTagged}, responses-routed: ${responsesRouted}, ` +
    `variants-carried: ${variantsCount}, anthropic: ${anthropicCount}, :free: ${freeCount}, ` +
    `opencode-blocks: ${withOpencode}/${catalog.length}`,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nkilo smoke: PASS");
