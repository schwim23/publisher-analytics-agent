# `x-publisher-analytics` — extension spec

**Status:** experimental · pre-ratification

This document describes the `x-publisher-analytics` MCP extension proposed by
[`publisher-analytics-agent`](https://github.com/schwim23/publisher-analytics-agent).
It is **not** part of the [AdCP 3.0](https://docs.adcontextprotocol.org) spec.
The extension is declared via `getAdcpCapabilities` so buyers can detect it,
but everything inside the extension namespace is subject to change before any
1.0 release.

The shape of this document mirrors the AdCP RFC template so it can be lifted
into a formal proposal once stable.

---

## Versioning

| Component | Value |
|---|---|
| Extension name | `x-publisher-analytics` |
| Extension version | `0.1.0` |
| Schema version | `0.1.0` |
| AdCP envelope | 3.x |

Breaking changes to request/response shapes bump the **schema** version.
Additive changes (new optional fields) leave it untouched.

---

## Capability discovery

The agent exposes its surface via `get_adcp_capabilities`. The relevant block:

```jsonc
{
  "extensions": {
    "x-publisher-analytics": {
      "version": "0.1.0",
      "schema_version": "0.1.0",
      "status": "experimental",
      "rfc": "https://github.com/adcontextprotocol/adcp/issues",
      "description": "Publisher-side aggregate analytics surface...",
      "tools": [
        "get_delivery_summary",
        "get_pacing_alerts",
        "get_morning_briefing",
        "get_yield_anomalies",
        "get_inventory_forecast",
        "compare_periods",
        "get_plan_audit_logs"
      ],
      "client_utilities": ["generate_visualization"],
      "limitations": [ /* see below */ ]
    }
  }
}
```

Buyers interested in the analytics surface MUST:

1. Call `get_adcp_capabilities`.
2. Confirm `extensions["x-publisher-analytics"]` exists.
3. Read its `tools` array — those are the analytics tools available.
4. Treat anything in `client_utilities` (e.g. `generate_visualization`) as a
   UI rendering helper, **not** as part of the AdCP data surface.

The agent does NOT declare any standard AdCP `supported_protocols` or
`specialisms` for analytics. Those fields are empty by design until the spec
ratifies an analytics protocol.

---

## Tools

All tools accept JSON-RPC arguments matching their `*Request` schema and
return MCP tool results with both `content` (human-readable summary text)
and `structuredContent` (parsed/validated `*Response` object).

### `get_delivery_summary`

Multi-dimensional delivery report.

**Request:** `DeliverySummaryRequest`
- `startDate`, `endDate` (YYYY-MM-DD, required)
- `dimensions: DimensionName[]` (default `["date"]`)
- `filter` (optional, backend-specific opaque string)

**Response:** `DeliverySummaryResponse` — totals, rows (`DeliveryMetricRow[]`),
warnings.

### `get_pacing_alerts`

Surface line items pacing under or over goals. Uses flight dates + delivery
telemetry where available, falls back to spend/budget with reduced
confidence.

**Request:** `{ threshold?: number (default 0.8) }`
**Response:** `PacingAlert[]` with severity, confidence, recommended_action.

### `get_morning_briefing`

Sectioned daily ops briefing.

**Request:** `{ lookbackDays?: number (1-30, default 1) }`
**Response:** sections — executive_summary, revenue_and_delivery, pacing_risks,
yield_anomalies, inventory_forecast_highlights, governance_audit_issues,
data_quality_caveats, recommended_actions.

### `get_yield_anomalies`

Compare a recent half of a window vs the older half; flag drops.

**Request:** `{ lookbackDays, dimensions, minImpressions }`
**Response:** anomalies with hypotheses (NOT verdicts), each carrying
confidence, evidence, and recommended_next_checks.

Checks include: traffic/impressions drop, fill/match rate drop, eCPM drop,
bid response rate drop, floor-price-up + fill-down compound, bidder timeout
spike, consent/identity availability changes, creative status problems.

### `get_inventory_forecast`

Project impressions + revenue for an ad unit over a future range.

**Request:** `{ adUnit, startDate, endDate }`
**Response:** projected & available impressions, projected revenue, basis
(`historical_delivery` | `true_availability_unknown`), confidence (low/med/high),
optional 80% confidence interval, caveats.

### `compare_periods`

Single-metric WoW/MoM/YoY comparison, optionally by dimension.

**Request:** `{ metric, periodA, periodB, dimension? }`
**Response:** value per period, delta, delta_percent, trend, optional rows
broken down by dimension.

### `get_plan_audit_logs`

Publisher-side audit trail. On AdCP-backend deployments maps to the spec's
`get_media_buy_artifacts`.

**Request:** `{ mediaBuyId?, planId?, startDate?, endDate?, limit }`
**Response:** summary + log entries.

### `generate_visualization` (client utility, not AdCP surface)

Turn a tool result into a chart spec for UI rendering.

---

## Data quality warnings

Every tool response includes a `warnings: DataQualityWarning[]` field. Codes:

| Code | Meaning |
|---|---|
| `REVENUE_FROM_BUYER_SPEND` | Revenue value is the buyer's reported spend, not publisher net revenue. |
| `NET_VS_GROSS_UNKNOWN` | Cannot distinguish gross vs net revenue. |
| `FILL_RATE_UNAVAILABLE` | Backend did not provide ad-request volume. |
| `TOTAL_REQUESTS_UNAVAILABLE` | No ad request count available. |
| `MATCH_RATE_UNAVAILABLE` | No matched-request count available. |
| `BUYER_DATA_LAG` | Buyer-reported data has known lag. |
| `STALE_DATA` | `data_freshness_timestamp` is older than the requested period. |
| `PARTIAL_PERIOD` | Window includes time after the freshness boundary. |
| `BACKEND_FALLBACK` | A degraded code path was used (e.g. impression history in lieu of ad-request history). |
| `MISSING_FLIGHT_DATES` | Pacing computed without flight start/end. |
| `MISSING_BOOKED_IMPRESSIONS` | Pacing computed without an impressions goal. |
| `MISSING_BUDGET` | Spend-based pacing skipped. |
| `INSUFFICIENT_HISTORY` | Forecast or anomaly check ran with too few samples. |
| `NULL_DIMENSION_VALUES` | Some rows had null dimension keys. |
| `UNKNOWN` | Generic — message field carries detail. |

Severity: `info` | `warning` | `critical`. Tools deduplicate warnings before
returning.

---

## Provenance

`DeliveryMetricRow.provenance` records where a value originated:

```ts
{
  source_system: string;     // "gam", "adcp-buyer", "stub", custom backend id
  source_task?: string;       // upstream RPC name
  source_field?: string;      // raw field, e.g. "stats.costInMoney.microAmount"
  source_record_id?: string;  // e.g. media_buy_id
  fetched_at?: string;        // ISO 8601
  derivation?: string;        // how the value was computed if transformed
}
```

Tools inheriting from `DeliveryRow` should set provenance whenever the source
backend exposes the underlying record id.

---

## Hypothesis envelope

Anomaly explanations are carried as `Hypothesis` objects, never definitive
causes:

```ts
{
  label: string;                       // short human-readable label
  confidence: 'low' | 'medium' | 'high';
  evidence: string[];                  // statements supporting the hypothesis
  recommended_next_checks: string[];   // what an analyst should verify
}
```

Multiple hypotheses per anomaly are allowed; agents should rank them by
`confidence` before presenting to a human.

---

## Security assumptions

- Servers run TLS termination upstream of the agent process.
- Authentication uses `Authorization: Bearer <token>` per AdCP 3.0.
- Each tool declares required scopes (`analytics:read`, `analytics:forecast`,
  `analytics:visualize`, `audit:read`, `capabilities:read`). The reference
  implementation's `assertScopes` runs ahead of every tool call.
- Multi-tenant deployments map bearer → tenant + scopes via a layer above the
  agent's HTTP server. The reference implementation operates single-tenant.
- An audit log records every tool call with `auth_mode`, `tenant_id`,
  `caller_id`, `params_hash` (sha256, truncated), `params_keys`, and the
  warnings count of the result. Raw revenue rows are never logged by default.

---

## Open questions / RFC topics

These are intentional gaps the working group should resolve before
ratification.

1. **Specialism vs extension.** Should `publisher-analytics` become a
   first-class AdCP specialism? If yes, what is the canonical name? Most
   likely candidates: `seller-yield-analytics`, `publisher-analytics`.
2. **Tool naming alignment.** Should `get_plan_audit_logs` be renamed to
   align with `get_media_buy_artifacts`, or kept as a publisher-aggregate
   distinct from the spec's per-buy artifact view?
3. **Net vs gross revenue.** The spec doesn't currently express revenue
   semantics. Should the analytics surface require explicit
   `revenue_net` and `revenue_gross` fields, or treat `revenue` as net by
   convention?
4. **Forecast guarantees.** Should the spec distinguish "delivery-based
   estimate" from "true availability forecast" (the latter being what an
   ad-server's native forecasting API returns)? The current
   `basis: 'historical_delivery' | 'true_availability_unknown'` is one
   proposal.
5. **Hypothesis structure.** Is `{ label, confidence, evidence,
   recommended_next_checks }` the right shape? Should `evidence` be
   structured (e.g. `{ metric, baseline, recent, pct_change }`) instead of
   strings?
6. **Storyboard suite.** What does conformance testing look like for an
   agent-as-vendor-extension? Should the WG publish storyboards under
   `static/compliance/source/extensions/`?

---

## Limitations (emitted in capabilities response)

- Pre-spec; not part of any ratified AdCP specialism.
- Tool argument and response schemas may change before 1.0.
- Revenue values mapped from buyer spend are estimates, not publisher-net
  revenue.
- Backends without ad-request or fill data return `null` for those metrics;
  tools degrade gracefully but lose precision.
- No formal storyboard suite exists for this extension yet — conformance is
  by review only.
