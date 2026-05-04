# publisher-analytics-agent

**Reference implementation of the AdCP publisher analytics agent** — an open-source agent type for yield, pacing, inventory, and audit analytics on ad-server data.

This package defines:

- A pluggable `DataClient` interface that any ad server can implement (GAM, AdCP, DV360, Xandr, custom SSP rollups).
- The standard tool surface — `get_delivery_summary`, `get_pacing_alerts`, `get_yield_anomalies`, `get_inventory_forecast`, `compare_periods`, `get_morning_briefing`, `get_plan_audit_logs`, `generate_visualization`, `get_adcp_capabilities`.
- An AdCP-conformant server: stdio MCP for Claude Desktop, HTTP MCP for network calls, `getAdcpCapabilities` discovery, bearer-auth, `.well-known/adagents.json` and `.well-known/brand.json` static endpoints.
- Pure analysis helpers (anomaly detection, pacing, forecasting) that operate on any `DataClient` implementation.
- An in-memory **stub backend** for credential-free demos.

> **Pre-spec preview.** AdCP 3.0 does not yet define an `analytics` protocol or a `publisher-analytics` specialism. This package declares its surface under the vendor-extension namespace `x-publisher-analytics` while a [forthcoming RFC](https://github.com/adcontextprotocol/adcp/issues) debates ratifying the agent type. See [adcontextprotocol.org](https://adcontextprotocol.org).

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

## Development

```bash
pnpm install
pnpm build           # compiles src/ + examples/ to dist/
pnpm typecheck
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
