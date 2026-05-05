# publisher-analytics-agent

**An AdCP-adjacent reference agent for publisher yield analytics** — open-source MCP server proposing an experimental `x-publisher-analytics` extension on top of the AdCP envelope.

> **This is NOT a ratified AdCP specialism.** AdCP 3.0 does not yet define an `analytics` protocol or a `publisher-analytics` specialism. The agent declares no `supported_protocols` or `specialisms`; everything analytics-shaped lives under the **vendor extension** `extensions["x-publisher-analytics"]` with `status: "experimental"`. Schemas may change. See [`EXTENSION_SPEC.md`](./EXTENSION_SPEC.md) for the full extension proposal and [adcontextprotocol.org](https://adcontextprotocol.org) for the underlying spec.

This package provides:

- **Schema-first contracts.** Every tool validates inputs and outputs against Zod schemas in `src/extension/schemas.ts`. Responses include both `structuredContent` (validated object) and `content` (concise text summary), so downstream agents get strong shapes and chat clients get readable summaries.
- **Pluggable backend.** A `DataClient` interface any ad server can implement — GAM, AdCP-spec'd buyer servers, DV360, Xandr, custom SSP rollups. Backends mark unavailable fields as `null` and emit `DataQualityWarning`s with provenance, so tools never silently lie.
- **Realistic publisher data model.** `DeliveryRow` carries 30+ optional fields covering ad requests, match/fill rates, viewability, bid/win/timeout rates, floor prices, demand-channel/SSP/deal/format, consent + identity availability, creative status, and freshness timestamps. Tools degrade gracefully when fields are missing.
- **Honest analytics.** Anomaly detection emits *hypotheses* with confidence + evidence + recommended_next_checks (never definitive causes). Pacing distinguishes flight-date-aware checks (high confidence) from spend/budget fallbacks (lower confidence). Inventory forecast labels `basis: 'historical_delivery'` vs `'true_availability_unknown'` and includes a confidence interval.
- **Auth + audit scaffolding.** `Authorization: Bearer <token>` per AdCP. Per-tool scope requirements (`analytics:read`, `analytics:forecast`, `analytics:visualize`, `audit:read`, `capabilities:read`) enforced before each call. Every tool invocation produces an audit-log event with `auth_mode`, `tenant_id`, `caller_id`, `params_hash`, `params_keys`, status, warnings count, and duration. Raw revenue rows are never logged.
- **Two transports.** stdio MCP for Claude Desktop; HTTP MCP for network calls with bearer auth, `.well-known/adagents.json`, `.well-known/brand.json`, and `/healthz`.
- **In-memory stub backend** for credential-free demos and tests.

### Discovery for buyers

Until the spec ratifies a formal discovery path for analytics agents, buyers calling this agent should:

1. Call `get_adcp_capabilities`.
2. Check that `extensions["x-publisher-analytics"]` is present.
3. Read `extensions["x-publisher-analytics"].tools` — that's the list of analytics tools the agent supports. (`client_utilities` lists rendering helpers like `generate_visualization`; treat those as UI affordances, not part of the AdCP data surface.)

The vendor namespace and tools array will become a formal `specialisms: ["publisher-analytics"]` claim once the RFC lands.

---

## Architecture

```
┌──────────────────────────────────────┐
│  AdCP Server                         │
│   stdio · HTTP · capabilities · auth │
├──────────────────────────────────────┤
│  Tool registry  (9 tools)            │
│  Analysis helpers · cache scheduler  │
└────────────────┬─────────────────────┘
                 │ DataClient interface
   ┌─────────────┴─────────────┐
   ▼                           ▼
 Your backend              Built-in clients
 (GAM SOAP, DV360,         · AdCPBuyerClient
  Xandr, custom SSPs…)       (any AdCP server)
                           · Stub backend
                             (in-memory demo)
```

You **bring a `DataClient`**; the package handles everything else (MCP wiring, transports, caching, capabilities, error envelopes).

---

## Quickstart

### Install

```bash
pnpm add publisher-analytics-agent
# or via git:
pnpm add github:schwim23/publisher-analytics-agent
```

### Pick a backend

| Backend | Setup time | Use it for |
|---|---|---|
| [**Stub**](#backend-1-stub-zero-credentials-demo) | 0 sec | Demos, dev, CI, screenshots |
| [**AdCP server**](#backend-2-adcp-conformant-server) | ~1 min | Any AdCP-spec'd ad server |
| [**Your own**](#backend-3-implement-dataclient) | varies | GAM, DV360, Xandr, FreeWheel, SSP rollups |

### Pick a transport

| Transport | Use it for |
|---|---|
| [**stdio MCP**](#stdio-claude-desktop) | Claude Desktop, direct MCP clients |
| [**HTTP MCP**](#http-network-callable-adcp-agent) | Network-callable AdCP agent, web app spawning the server, multi-agent setups |

---

## Backend 1: Stub (zero credentials, demo)

A runnable example ships in `examples/stub-backend/`. Deterministic synthetic data: four ad units (`Homepage_Top`, `Homepage_Sidebar`, `Article_Inline`, `Footer_Banner`), four SSPs (`google_adx`, `pubmatic`, `magnite`, `index`), bounded numbers (impressions 1k–51k, eCPM $1–9, fill rate 60–95%).

Clone, build, run:

```bash
git clone https://github.com/schwim23/publisher-analytics-agent.git
cd publisher-analytics-agent
pnpm install
pnpm build

# stdio (for Claude Desktop)
pnpm example:stdio

# HTTP, with bearer auth
ADAM_TRANSPORT=http BEARER=test-token PORT=7000 pnpm example:http
```

Smoke-test the HTTP server:

```bash
curl -sS http://localhost:7000/healthz
curl -sS http://localhost:7000/.well-known/brand.json
curl -sS -X POST http://localhost:7000/mcp/ \
  -H "Authorization: Bearer test-token" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoketest","version":"0.1"}},"id":0}'
```

---

## Backend 2: AdCP-conformant server

`AdCPBuyerClient` implements `DataClient` against any server speaking AdCP 3.0 — **MCP/JSON-RPC over HTTP** at `/mcp/`, with `Authorization: Bearer <token>` auth. The client invokes the spec's MCP tools (`get_media_buys`, `get_products`, `get_media_buy_delivery`, `get_media_buy_artifacts`, `check_governance`); no REST endpoints are assumed.

```ts
import {
  createPublisherAnalyticsServer,
  AdCPBuyerClient,
} from 'publisher-analytics-agent';

const dataClient = new AdCPBuyerClient({
  baseUrl: process.env.ADCP_BASE_URL!,   // e.g. https://adcp.your-vendor.com
  apiKey: process.env.ADCP_API_KEY!,
});

await createPublisherAnalyticsServer({
  transport: 'stdio',
  dataClient,
  agent: { id: 'my-pub', name: 'My Publisher Analytics', version: '0.1.0' },
});
```

The base URL can point at the host root (`https://adcp.example.com`) or directly at `/mcp/` — the client normalizes either form. Tool argument shapes are best-effort against AdCP 3.0 conventions; if your conformance suite enforces specific keys/casing, override per-tool by subclassing or call MCP tools directly via `getRawClient()`.

To exercise this without provisioning your own server, the [Prebid `salesagent`](https://github.com/adcontextprotocol/salesagent) repo ships a Dockerized mock AdCP server.

---

## Backend 3: Implement `DataClient`

For GAM, DV360, Xandr, FreeWheel, SSP reporting APIs (Magnite/PubMatic/Index/etc.), or anything custom — implement the `DataClient` interface:

```ts
import type {
  DataClient,
  DeliveryQuery,
  DeliveryRow,
  MediaBuy,
  DeliveryReport,
  GovernanceResult,
  InventoryProduct,
  AuditLogEntry,
} from 'publisher-analytics-agent';

class MyAdServerClient implements DataClient {
  async getDeliveryReport(query: DeliveryQuery): Promise<DeliveryRow[]> {
    // Translate `query.dimensions` and `query.startDate`/`endDate` into your
    // ad server's report API and map the response into `DeliveryRow[]`.
  }

  async listMediaBuys(filters?): Promise<MediaBuy[]> { /* ... */ }
  async getMediaBuyDelivery(id, range?): Promise<DeliveryReport[]> { /* ... */ }
  async checkGovernance(id): Promise<GovernanceResult> { /* ... */ }
  async getProducts(params): Promise<InventoryProduct[]> { /* ... */ }
  async getPlanAuditLogs(params): Promise<AuditLogEntry[]> { /* ... */ }
  async getAllDeliveryReports(range?): Promise<...> { /* ... */ }

  // Optional — backends with slow report jobs (e.g. GAM) implement this so
  // the cache scheduler can warm "yesterday" and "today" in the background.
  async refreshDeliveryCache?(range): Promise<void> { /* ... */ }
}
```

A worked example for Google Ad Manager lives at [`schwim23/ADam/packages/mcp-server/src/gam`](https://github.com/schwim23/ADam/tree/main/packages/mcp-server/src/gam).

Once your client exists:

```ts
import { createPublisherAnalyticsServer, CacheScheduler } from 'publisher-analytics-agent';

const dataClient = new MyAdServerClient(/* ... */);
new CacheScheduler(dataClient).start();   // optional, no-op if refreshDeliveryCache isn't implemented

await createPublisherAnalyticsServer({
  transport: 'stdio',
  dataClient,
  agent: { id: 'my-pub', name: 'My Publisher', version: '0.1.0' },
});
```

---

## Transport: stdio (Claude Desktop)

`transport: 'stdio'` connects the agent to a stdio-based MCP client. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "publisher-analytics": {
      "command": "node",
      "args": ["/absolute/path/to/your/built-shim.js"]
    }
  }
}
```

For a quick zero-config check, point Claude Desktop at the included stub:

```json
{
  "mcpServers": {
    "publisher-analytics-stub": {
      "command": "node",
      "args": ["/absolute/path/to/publisher-analytics-agent/dist/examples/stub-backend/index.js"]
    }
  }
}
```

After restarting Claude Desktop, all 9 tools are available inline.

---

## Transport: HTTP (network-callable AdCP agent)

`transport: 'http'` runs the agent over MCP-over-HTTP at `/mcp/` with bearer auth, plus `.well-known/*` discovery so other AdCP agents can find it.

```ts
const handle = await createPublisherAnalyticsServer({
  transport: 'http',
  dataClient,
  agent: { id: 'my-pub', name: 'My Publisher', version: '0.1.0' },
  port: 7000,
  host: '127.0.0.1',                   // bind address
  bearerToken: process.env.BEARER,     // required in `Authorization: Bearer <token>` header

  // Optional well-known endpoints — passed through verbatim as JSON
  wellKnownAdagents: { agents: [/* publisher's authorized agents */] },
  wellKnownBrand: {
    name: 'My Publisher',
    analytics_agent: { uri: 'https://my-pub.example.com/mcp/', protocol: 'mcp' },
  },
});

// `handle` exposes `.close()` for graceful shutdown
```

Endpoints:

| Endpoint | What it does |
|---|---|
| `POST /mcp/` | MCP-over-HTTP. `Authorization: Bearer <token>` required. |
| `GET /.well-known/adagents.json` | Authorized-agents manifest, if `wellKnownAdagents` was provided. |
| `GET /.well-known/brand.json` | Brand manifest, if `wellKnownBrand` was provided. |
| `GET /healthz` | Health check. No auth. |

> Run TLS termination in front of this in production. Bearer-token check protects `/mcp/` but doesn't encrypt traffic.

---

## Tools

The agent exposes nine tools over MCP:

| Tool | Description |
|---|---|
| `get_delivery_summary` | Multi-dimensional delivery report (date / ad unit / SSP / device / country / order / line item). |
| `get_pacing_alerts` | Line items pacing under- or over- their goals. |
| `get_morning_briefing` | Network revenue, eCPM, fill rate, top units, SSP breakdown. |
| `get_yield_anomalies` | eCPM and fill drops vs. baseline period, with inferred causes. |
| `get_inventory_forecast` | Project available impressions for an ad unit over a future range. |
| `compare_periods` | WoW / MoM / YoY / custom-range comparisons. |
| `get_plan_audit_logs` | Publisher-side audit trail. The AdCP backend (when used) maps this to the spec's `get_media_buy_artifacts` task. Returns empty for backends that don't expose an audit trail (e.g. GAM). |
| `generate_visualization` | Turn a tool result into a chart spec (line / bar / area / pie). |
| `get_adcp_capabilities` | AdCP capability envelope: protocol, specialisms, extensions, supported transports. |

---

## Sample tool response

Every analytics tool returns BOTH `structuredContent` (the validated response object) and `content` (a concise human-readable summary). Example abbreviated `get_morning_briefing` response:

```jsonc
{
  "content": [{ "type": "text", "text": "📊 Morning briefing — 2026-05-03 → 2026-05-03\n\n1d window..." }],
  "structuredContent": {
    "period": { "start": "2026-05-03", "end": "2026-05-03" },
    "executive_summary": "1d window ending 2026-05-03: 1,234,567 impressions · $850.00 revenue · $0.69 eCPM (net) · 67.30% fill.",
    "revenue_and_delivery": {
      "impressions": 1234567,
      "revenue_gross": 1100,
      "revenue_net": 850,
      "ecpm_net": 0.69,
      "fill_rate": 0.673,
      "ctr": 0.004,
      "top_ad_units": [ /* up to 10, sorted by revenue */ ],
      "ssp_breakdown": [ /* sorted by revenue */ ]
    },
    "pacing_risks": [],
    "yield_anomalies": [],
    "data_quality_caveats": [
      { "code": "REVENUE_FROM_BUYER_SPEND", "severity": "warning", "message": "..." }
    ],
    "recommended_actions": ["Investigate low fill rate; check SSP connectivity and floor prices."],
    "generated_at": "2026-05-04T00:00:00.000Z"
  }
}
```

The full response shape lives in `src/extension/schemas.ts` as `morningBriefingResponseSchema`. Same pattern applies to all analytics tools.

## Data model

`DeliveryRow` (in `src/adcp/types.ts`) is the canonical row shape passed between backends and tools. Highlights:

- **Volume:** `ad_requests`, `matched_requests`, `unfilled_requests`, `bid_requests`, `bid_responses`, `impressions`, `viewable_impressions`, `clicks`.
- **Revenue (explicit semantics):** `revenue_gross`, `revenue_net`, `buyer_spend`, plus matching `ecpm_gross`, `ecpm_net`. All nullable.
- **Rates:** `fill_rate`, `match_rate`, `viewability_rate`, `win_rate`, `bid_rate`, `timeout_rate`. Range `[0, 1]` or null.
- **Identifiers/dimensions:** `bidder`, `ssp`, `deal_id`, `order_id`, `line_item_id`, `ad_unit`, `placement`, `format`, `device`, `geo`, `content_category`, `demand_channel`.
- **Pricing:** `floor_price`.
- **Compliance:** `consent_status`, `identity_present`, `creative_status`.
- **Origin:** `source_system`, `data_freshness_timestamp`, `warnings: DataQualityWarning[]`, `provenance`.

Backends should populate the fields they have, set unavailable fields to `null`, and emit a `DataQualityWarning` per unavailable category. Tools handle nulls; they degrade in precision but never fabricate values.

## Public API

```ts
// Server entrypoint
export function createPublisherAnalyticsServer(opts: {
  transport: 'stdio' | 'http';
  dataClient: DataClient;
  agent: { id: string; name: string; version: string };
  // HTTP-only:
  port?: number;
  host?: string;
  bearerToken?: string;
  wellKnownAdagents?: unknown;
  wellKnownBrand?: unknown;
  channels?: string[];
}): Promise<RunningHttpServer | void>;

// Backends
export class AdCPBuyerClient { /* implements DataClient */ }

// Caching helpers
export class CacheScheduler { /* warms `refreshDeliveryCache` per backend */ }
export class ReportCache { /* on-disk cache primitives */ }
export const TTL: { DELIVERY_TODAY; DELIVERY_HISTORY };
export function deliveryTTL(endDate: string): number;

// AdCP envelope + capabilities
export function buildCapabilities(ctx): unknown;
export function toErrorEnvelope(err: unknown): { body; isError: true };

// Types
export type {
  DataClient, DeliveryQuery, DeliveryDimension,
  DeliveryRow, MediaBuy, DeliveryReport,
  GovernanceResult, GovernanceViolation,
  InventoryProduct, AuditLogEntry, AdCPError,
  AdCPErrorBody, AdCPErrorCode,
  StdioServerOptions, HttpServerOptions, RunningHttpServer,
};
```

The default disk cache lives at `~/.publisher-analytics/cache/`; pass a `cacheDir` to `new ReportCache({...})` to override.

---

## Real deployments

| Deployment | Backend | Repo |
|---|---|---|
| **ADam** | Google Ad Manager (SOAP) | [`schwim23/ADam`](https://github.com/schwim23/ADam) — also ships a Next.js web UI and CLI as reference clients |

Want yours listed? Open a PR.

---

## What this does NOT do

- **Not a ratified AdCP analytics implementation.** Capabilities declare zero `supported_protocols` and zero `specialisms`. The analytics surface is a vendor extension only.
- **Not a guaranteed availability forecaster.** `get_inventory_forecast` projects from delivery history. For true availability use your ad-server's native forecasting API.
- **Not a multi-tenant production server.** The HTTP server runs single-tenant: a bearer token grants the configured scope set. Multi-tenant deployments must layer their own bearer→tenant+scope mapping above this.
- **Not a publisher revenue source-of-truth.** When the backend exposes only buyer-side spend (e.g. AdCP buyer client), revenue is reported as `buyer_spend` and the legacy `revenue` field is annotated with a `REVENUE_FROM_BUYER_SPEND` warning. Don't book financial reports off these numbers.
- **Not a replacement for storyboard testing.** The extension hasn't been through formal AdCP conformance testing; conformance is by review only.

## Production hardening checklist

Before pointing this at real publisher revenue data:

- [ ] Run TLS termination in front of the HTTP server.
- [ ] Generate a strong bearer token; rotate quarterly.
- [ ] If multi-tenant, layer your own bearer→tenant mapping; the reference impl is single-tenant.
- [ ] Implement a `DataClient` against your ad server; do **not** ship the stub to production.
- [ ] Set `bearerScopes` to the minimum your callers need (avoid `ALL_SCOPES`).
- [ ] Wire `setAuditSink()` to a real log pipeline; the default stderr sink + ring buffer is for development.
- [ ] Add request-rate limiting at the proxy/load-balancer layer (this server has none).
- [ ] Pin the `publisher-analytics-agent` version in your lockfile; the schema is pre-1.0.
- [ ] Confirm your `DataClient` impl marks unknown fields as `null` (not `0`) and emits warnings — silent zeros corrupt downstream analysis.
- [ ] Configure `wellKnownAdagents` and `wellKnownBrand` JSON for AdCP discovery.

## Development

```bash
pnpm install
pnpm build           # compiles src/ + examples/ to dist/
pnpm typecheck
pnpm test            # vitest run — schema validation, mapping, anomaly/pacing/briefing/auth tests
pnpm example:stdio   # run the stub backend over stdio
pnpm example:http    # run the stub backend over HTTP (port 7000)
```

---

## Relationship to AdCP

[AdCP](https://adcontextprotocol.org) is the open standard governing this work. This package is positioned as the reference implementation for the publisher-side analytics agent type. A forthcoming RFC at [`adcontextprotocol/adcp`](https://github.com/adcontextprotocol/adcp) will propose ratifying an `analytics` protocol with a `publisher-analytics` specialism; until that lands, the agent declares its surface via the `x-publisher-analytics` vendor extension on `getAdcpCapabilities`.

The split between this repo and ADam mirrors how AdCP itself is structured — the spec lives in [`adcontextprotocol/adcp`](https://github.com/adcontextprotocol/adcp), the SDK in [`adcontextprotocol/adcp-client`](https://github.com/adcontextprotocol/adcp-client), and individual agent implementations are separate.

---

## License

Apache 2.0 — same as AdCP.
