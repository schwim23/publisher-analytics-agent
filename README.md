# publisher-analytics-agent

Reference implementation of the **AdCP publisher analytics agent** — an open-source agent type for yield, pacing, inventory, and audit analytics on ad-server data.

This package defines:

- A pluggable `DataClient` interface that any ad server can implement (GAM, AdCP, DV360, Xandr, etc.).
- The standard tool surface that publisher analytics agents expose over MCP — `get_delivery_summary`, `get_pacing_alerts`, `get_yield_anomalies`, `get_inventory_forecast`, `compare_periods`, `get_morning_briefing`, `get_plan_audit_logs`, `generate_visualization`.
- An AdCP-conformant server (HTTP MCP transport, `getAdcpCapabilities`, bearer auth, `.well-known/*` discovery).
- Pure analysis helpers that operate on any `DataClient` implementation.

## Status

**Pre-spec preview.** AdCP 3.0 does not yet define an `analytics` protocol or a `publisher-analytics` specialism. This package ships under the vendor-extension namespace `x-publisher-analytics` while a [forthcoming RFC](https://github.com/adcontextprotocol/adcp/issues) at the AdCP working group debates ratifying the agent type. See [adcontextprotocol.org](https://adcontextprotocol.org).

## Usage

Implement `DataClient` for your backend, then mount the agent:

```ts
import { createPublisherAnalyticsServer } from 'publisher-analytics-agent';
import type { DataClient } from 'publisher-analytics-agent';

const dataClient: DataClient = /* your implementation */;

const server = createPublisherAnalyticsServer({
  dataClient,
  transport: 'stdio', // or 'http'
});
await server.start();
```

For a worked example with a real ad-server backend, see [ADam](https://github.com/schwim23/ADam) — the GAM-backed deployment.

## License

Apache 2.0 — same as AdCP.
