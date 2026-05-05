# Changelog

All notable changes to `publisher-analytics-agent` will be documented in this file.

The format is loosely [Keep a Changelog](https://keepachangelog.com/) and the project adheres to [Semantic Versioning](https://semver.org/) where the major version is `0` (pre-1.0; breaking changes expected).

## [Unreleased]

### Added
- **`get_deal_diagnostics` tool** — first-class deal health analysis under the `x-publisher-analytics` extension. Walks the deal auction funnel (eligible_ad_requests → deal_bid_requests → bid_responses → bids_above_floor → auction_wins → impressions), computes pacing on `booked_impressions` / `booked_revenue` / `booked_budget` basis when flight dates exist, and emits **hypotheses** for SUPPLY_CONSTRAINT, LOW_BID_RATE, FLOOR_MISMATCH, LOW_WIN_RATE, CREATIVE_BLOCKED, UNDERPACING, ROUTING_OR_SSP_ISSUE, DATA_INSUFFICIENT. Each issue carries severity, confidence, supporting evidence, recommended next checks, and recommended actions.
  - New schemas in `src/extension/schemas.ts`: `DealDiagnosticsRequest`, `DealDiagnosticsResponse`, `DealDiagnosticsEntry`, `DealDiagnosticIssue`, `DealFunnel`, `DealPacing`, `DealBreakdown`, `DealMetricRow`. New enums: `DealType`, `DealHealthStatus`, `DealIssueCode`, `DealDimension`.
  - New optional `DataClient.getDealDiagnosticsData(req)` method. Backends without per-deal funnel data return empty / null and the tool emits `BACKEND_FALLBACK` rather than fabricating metrics.
  - `get_morning_briefing` gains `include_deal_diagnostics` + `deal_ids` flags. When set, it summarizes top at-risk deals into a `deal_diagnostics` field on the response.
  - Stub backend ships 5 fixture deals exercising each rule at least once: healthy PG, supply-constrained, PMP with low bid response, floor mismatch, creative blocked.
  - 14 new tests across schema validation, every diagnostic rule, response-schema round-trip, BACKEND_FALLBACK path, and capability advertisement.
- **Per-request HTTP `AuthContext` via `AsyncLocalStorage`.** The HTTP transport builds an `AuthContext` for each request from the parsed `Authorization: Bearer <token>` header (with a non-leaking `caller_id` derived from the token fingerprint) and runs the MCP transport inside `authContextStore.run(...)`. Tools read the per-request context via `currentAuthContext()` instead of a server-wide singleton.
- **Typed `DeliveryFilter`** on `DeliveryQuery` — `ad_unit`, `line_item_id`, `deal_id`, `demand_channel`, `device`, `geo`, `format`, `ssp`, `bidder`. Replaces opaque PQL/SQL strings in new code; the legacy `filter` string is kept on `DeliveryQuery` for GAM-flavored backends and is documented as deprecated.
- **Separate impressions and revenue confidence intervals** on `inventoryForecastResponse`. `impressions_confidence_interval` derives from per-day impression sample variance; `revenue_confidence_interval` derives from per-day revenue sample variance directly. Each carries an explicit `level` field (default 0.8). Composing a revenue CI from `impressions × eCPM` would understate variance and is explicitly avoided.
- **Inline section composition for `get_morning_briefing`.** New request flags `include_pacing_risks`, `include_yield_anomalies`, `include_inventory_forecast`, `include_governance`. Defaults: pacing + yield (cheap), forecast + governance off (more expensive). Section failures degrade to data-quality caveats rather than silent empty sections.
- **Audit sink testing + production-friendly extension point.** New tests verify `setAuditSink()` receives only hashed/redacted params and that raw revenue rows are never logged. README has an external-sink example.
- **Expanded buyer-client tests through the MCP boundary.** New tests cover URL normalization, `Authorization: Bearer` header attachment, `get_media_buys` argument shape (no `media_buy_ids: []`), `get_products` always sending `buying_mode`, `get_media_buy_artifacts` time_range with ISO 8601 datetimes and exclusive end, fan-out across active buys when no media_buy_id is supplied, response-shape unwrapping (wrapped vs raw array), and error-path behavior (`isError: true` becomes a thrown Error).
- **CHANGELOG.md** (this file).

### Changed
- `inventoryForecastResponse.confidence_interval` → `impressions_confidence_interval` (renamed for clarity); `revenue_confidence_interval` is a new sibling.
- HTTP `AuthContext` is no longer a server-wide singleton. The `bearerAuthContext` was replaced with a per-request build via ALS. The HTTP server's `bearerScopes` and `tenantId` options still apply but are now lifted into each request's context rather than shared globally.
- `EXTENSION_SPEC.md` updated with: typed `DeliveryFilter` contract, inline-composition flags on `get_morning_briefing`, dual confidence intervals on `get_inventory_forecast`.

## [0.1.0] — 2026-05-04

The initial schema-first reference upgrade from demo-quality to a credible pre-spec extension proposal.

### Added
- **Schema-first contracts** in `src/extension/schemas.ts`. Every tool validates inputs and outputs against Zod schemas. Reusable primitives: `DateRange`, `MetricName`, `DimensionName`, `DeliveryMetricRow`, `DataQualityWarning`, `Provenance`, `ConfidenceLevel`, `Hypothesis`. Schema version is exposed on `getAdcpCapabilities`.
- **`structuredContent` + `content` on every tool result.** Validated response object for downstream agents; concise summary text for chat clients. Helper at `src/extension/tool-result.ts`.
- **Realistic publisher data model.** `DeliveryRow` extended with 30+ optional fields covering ad requests, match/fill rates, viewability, bid/win/timeout rates, floor prices, demand channel / SSP / deal / format, consent + identity availability, creative status, source system, freshness timestamp, warnings, and provenance. Legacy fields preserved.
- **Honest analytics tools.**
  - `get_yield_anomalies` emits hypotheses with confidence + evidence + recommended next checks (never definitive causes). Adds floor-price+fill compound, bidder timeout spike, consent/identity changes, creative-status problems.
  - `get_pacing_alerts` distinguishes flight-date-aware checks (high confidence) from spend-only fallbacks. Emits `MISSING_FLIGHT_DATES`, `MISSING_BUDGET`, `no_data` alerts.
  - `get_inventory_forecast` labels its `basis` (`historical_delivery` vs `true_availability_unknown`) and reports an 80% confidence interval.
  - `get_morning_briefing` returns sectioned response (executive summary, revenue+delivery, pacing risks, yield anomalies, inventory highlights, governance issues, data-quality caveats, recommended actions).
- **Auth + scope + audit scaffolding.** `AuthContext` with `tenant_id`, `caller_id`, `scopes`. Per-tool required scopes (`analytics:read`, `analytics:forecast`, `analytics:visualize`, `audit:read`, `capabilities:read`). Stdio uses `DEV_BYPASS_CONTEXT`; HTTP uses bearer-mode. `assertScopes` runs ahead of every tool. `withAudit` wraps dispatch and emits an `AuditEvent` per call (timestamp, tool, auth_mode, tenant_id, caller_id, params_hash sha256-truncated, params_keys, status, warnings_count, duration). Default sink: stderr + 256-event ring buffer, swappable via `setAuditSink()`. Raw revenue rows are never logged.
- **Buyer-client mapping safety.** `AdCPBuyerClient.getDeliveryReport` no longer fakes `totalRequests=impressions` or `fillRate=1`. Buyer spend is mapped to `buyer_spend` (and the legacy `revenue` field) with `REVENUE_FROM_BUYER_SPEND`, `NET_VS_GROSS_UNKNOWN`, `FILL_RATE_UNAVAILABLE`, and `TOTAL_REQUESTS_UNAVAILABLE` warnings. Each row carries `provenance` pointing back at the AdCP task and source record.
- **AdCP-conformant capabilities envelope.** Top-level `adcp` object with `major_versions: [3]` and `idempotency: { supported: false }`. `supported_protocols: []` and `specialisms: []` (no overclaiming). Extension block declares `status: "experimental"`, `schema_version`, RFC link, and a `limitations` array. Visualization is split into `client_utilities` distinct from analytics `tools`.
- **Standard `Authorization: Bearer <token>`.** HTTP transport accepts the spec-correct header. `x-adcp-auth` was removed.
- **Stub backend** populating the realistic publisher metrics — gross/net revenue, ad_requests, viewability, bidding rates, floor prices, consent, identity, creative status — for credential-free demos and tests.
- **Vitest test suite** covering schema validation, AdCP buyer mapping with missing fields, anomaly detection (eCPM drop, fill+floor compound, equivalent periods), pacing (flight-aware, missing dates, no-data), morning briefing composition, scope enforcement.
- **README + EXTENSION_SPEC.md** documenting the experimental-extension framing, data model, capability discovery, security assumptions, and open RFC questions.
