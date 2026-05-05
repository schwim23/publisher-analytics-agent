import { z } from 'zod';

/**
 * Schema-first contracts for the `x-publisher-analytics` MCP extension.
 *
 * Every tool validates its inputs against a *Request schema and its outputs
 * against a *Response schema. Schemas are the single source of truth — both
 * the JSON Schemas declared on MCP tool definitions and the runtime guards
 * derive from them.
 *
 * Versioning: the schema set carries its own `EXTENSION_SCHEMA_VERSION`,
 * surfaced via `getAdcpCapabilities`. Breaking changes bump major.
 */

export const EXTENSION_NAME = 'x-publisher-analytics';
export const EXTENSION_VERSION = '0.1.0';
export const EXTENSION_SCHEMA_VERSION = '0.1.0';

/* ─────────────────────────  Reusable primitives  ───────────────────────── */

export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const isoDatetime = z.string().datetime();

export const dateRangeSchema = z.object({
  start: dateString.describe('Inclusive start (YYYY-MM-DD)'),
  end: dateString.describe('Inclusive end (YYYY-MM-DD)'),
});
export type DateRange = z.infer<typeof dateRangeSchema>;

export const dimensionNameSchema = z.enum([
  'date',
  'ad_unit',
  'order',
  'line_item',
  'device',
  'country',
  'ssp',
  'bidder',
  'deal_id',
  'placement',
  'format',
  'geo',
  'content_category',
  'demand_channel',
]);
export type DimensionName = z.infer<typeof dimensionNameSchema>;

export const metricNameSchema = z.enum([
  'impressions',
  'clicks',
  'revenue',
  'revenue_gross',
  'revenue_net',
  'buyer_spend',
  'ecpm',
  'ecpm_gross',
  'ecpm_net',
  'ctr',
  'fill_rate',
  'match_rate',
  'viewability_rate',
  'win_rate',
  'bid_rate',
  'timeout_rate',
  'ad_requests',
  'matched_requests',
  'unfilled_requests',
  'viewable_impressions',
]);
export type MetricName = z.infer<typeof metricNameSchema>;

export const confidenceLevelSchema = z.enum(['low', 'medium', 'high']);
export type ConfidenceLevel = z.infer<typeof confidenceLevelSchema>;

export const severitySchema = z.enum(['info', 'warning', 'critical']);
export type Severity = z.infer<typeof severitySchema>;

/**
 * Provenance captures *where* a value came from. Critical for publisher
 * revenue data because the same `revenue` field can mean very different
 * things depending on whether it was derived from a buyer's reported
 * spend (gross to the buyer, an estimate to the publisher) or from the
 * publisher's own reporting system (net to the publisher, after rev share).
 */
export const provenanceSchema = z.object({
  source_system: z.string().describe('e.g. "gam", "adcp-buyer", "stub", or a custom backend id'),
  source_task: z.string().optional().describe('AdCP task or backend RPC the value came from'),
  source_field: z.string().optional().describe('Field name on the source record (e.g. "stats.costInMoney.microAmount")'),
  source_record_id: z.string().optional().describe('Identifier of the source record (e.g. media_buy_id, line_item_id)'),
  fetched_at: isoDatetime.optional(),
  derivation: z.string().optional().describe('How the value was computed if it was transformed (e.g. "buyer.spend / 1_000_000")'),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const dataQualityWarningSchema = z.object({
  code: z.enum([
    'REVENUE_FROM_BUYER_SPEND',
    'NET_VS_GROSS_UNKNOWN',
    'FILL_RATE_UNAVAILABLE',
    'TOTAL_REQUESTS_UNAVAILABLE',
    'MATCH_RATE_UNAVAILABLE',
    'BUYER_DATA_LAG',
    'STALE_DATA',
    'PARTIAL_PERIOD',
    'BACKEND_FALLBACK',
    'MISSING_FLIGHT_DATES',
    'MISSING_BOOKED_IMPRESSIONS',
    'MISSING_BUDGET',
    'INSUFFICIENT_HISTORY',
    'NULL_DIMENSION_VALUES',
    'UNKNOWN',
  ]),
  message: z.string(),
  severity: severitySchema.default('warning'),
  affected_field: z.string().optional(),
  affected_count: z.number().int().nonnegative().optional(),
});
export type DataQualityWarning = z.infer<typeof dataQualityWarningSchema>;

/**
 * Hypothesis (not "cause") — anomaly explanations are educated guesses, not
 * verdicts. Each carries a confidence level, a list of supporting evidence
 * strings, and recommended next checks the analyst should run to confirm.
 */
export const hypothesisSchema = z.object({
  label: z.string().describe('Short hypothesis label, e.g. "Demand-side eCPM compression on premium ad units"'),
  confidence: confidenceLevelSchema,
  evidence: z.array(z.string()).default([]),
  recommended_next_checks: z.array(z.string()).default([]),
});
export type Hypothesis = z.infer<typeof hypothesisSchema>;

/**
 * Canonical row shape used by analytics tools for delivery data. All fields
 * are *optional* because backends vary in what they expose. Consumers MUST
 * check for `null` / `undefined` before using a field. Provenance + warnings
 * give the agent context for honest reporting.
 */
export const deliveryMetricRowSchema = z.object({
  dimensions: z.record(z.string(), z.string()).default({}),

  // Volume
  ad_requests: z.number().nullish(),
  matched_requests: z.number().nullish(),
  unfilled_requests: z.number().nullish(),
  bid_requests: z.number().nullish(),
  bid_responses: z.number().nullish(),
  impressions: z.number().nullish(),
  viewable_impressions: z.number().nullish(),
  clicks: z.number().nullish(),

  // Revenue (semantics differ; keep separate fields)
  revenue_gross: z.number().nullish().describe('Gross revenue at the publisher, if known'),
  revenue_net: z.number().nullish().describe('Net revenue at the publisher (after rev share), if known'),
  buyer_spend: z.number().nullish().describe('Spend reported by the buyer; differs from publisher revenue'),

  // Derived rates (nullable when source fields unavailable)
  ecpm_gross: z.number().nullish(),
  ecpm_net: z.number().nullish(),
  fill_rate: z.number().min(0).max(1).nullish(),
  match_rate: z.number().min(0).max(1).nullish(),
  ctr: z.number().min(0).max(1).nullish(),
  viewability_rate: z.number().min(0).max(1).nullish(),
  win_rate: z.number().min(0).max(1).nullish(),
  bid_rate: z.number().min(0).max(1).nullish(),
  timeout_rate: z.number().min(0).max(1).nullish(),

  // Pricing
  floor_price: z.number().nullish(),

  // Identifiers (often appear in dimensions too; keep as typed fields too)
  bidder: z.string().nullish(),
  ssp: z.string().nullish(),
  deal_id: z.string().nullish(),
  order_id: z.string().nullish(),
  line_item_id: z.string().nullish(),
  ad_unit: z.string().nullish(),
  placement: z.string().nullish(),
  format: z.string().nullish(),
  device: z.string().nullish(),
  geo: z.string().nullish(),
  content_category: z.string().nullish(),
  demand_channel: z.string().nullish(),

  // Compliance / context
  consent_status: z.string().nullish(),
  identity_present: z.boolean().nullish(),
  creative_status: z.string().nullish(),

  // Origin
  source_system: z.string().nullish(),
  data_freshness_timestamp: isoDatetime.nullish(),
  warnings: z.array(dataQualityWarningSchema).default([]),
  provenance: provenanceSchema.optional(),
});
export type DeliveryMetricRow = z.infer<typeof deliveryMetricRowSchema>;

/* ─────────────────────────  Per-tool schemas  ─────────────────────────── */

// get_delivery_summary
export const deliverySummaryRequestSchema = z.object({
  startDate: dateString,
  endDate: dateString,
  dimensions: z.array(dimensionNameSchema).default(['date']),
  filter: z.string().optional().describe('Backend-specific filter string. Opaque to the agent.'),
});
export type DeliverySummaryRequest = z.infer<typeof deliverySummaryRequestSchema>;

export const deliverySummaryResponseSchema = z.object({
  period: dateRangeSchema,
  dimensions: z.array(dimensionNameSchema),
  totals: z.object({
    impressions: z.number().nullish(),
    clicks: z.number().nullish(),
    revenue_gross: z.number().nullish(),
    revenue_net: z.number().nullish(),
    buyer_spend: z.number().nullish(),
    ecpm_gross: z.number().nullish(),
    ecpm_net: z.number().nullish(),
    ctr: z.number().nullish(),
    fill_rate: z.number().nullish(),
  }),
  rows: z.array(deliveryMetricRowSchema),
  row_count: z.number().int().nonnegative(),
  warnings: z.array(dataQualityWarningSchema).default([]),
  generated_at: isoDatetime,
});
export type DeliverySummaryResponse = z.infer<typeof deliverySummaryResponseSchema>;

// get_pacing_alerts
export const pacingAlertsRequestSchema = z.object({
  threshold: z.number().min(0).max(1).default(0.8),
});
export type PacingAlertsRequest = z.infer<typeof pacingAlertsRequestSchema>;

export const pacingAlertSchema = z.object({
  line_item_id: z.string(),
  name: z.string(),
  type: z.enum(['underdelivery', 'overspend', 'overpacing', 'no_data']),
  severity: severitySchema,
  message: z.string(),
  recommended_action: z.string(),
  confidence: confidenceLevelSchema,
  pacing_ratio: z.number().nullish(),
  spend_ratio: z.number().nullish(),
  flight: z.object({
    start: dateString.nullish(),
    end: dateString.nullish(),
    elapsed_fraction: z.number().min(0).max(1).nullish(),
  }).optional(),
  warnings: z.array(dataQualityWarningSchema).default([]),
});
export type PacingAlert = z.infer<typeof pacingAlertSchema>;

export const pacingAlertsResponseSchema = z.object({
  alerts: z.array(pacingAlertSchema),
  total: z.number().int().nonnegative(),
  warnings: z.array(dataQualityWarningSchema).default([]),
  generated_at: isoDatetime,
});
export type PacingAlertsResponse = z.infer<typeof pacingAlertsResponseSchema>;

// get_morning_briefing
export const morningBriefingRequestSchema = z.object({
  lookbackDays: z.number().int().min(1).max(30).default(1),
  /** Compose pacing-risks section internally. Cheap (one delivery query). Default: true. */
  include_pacing_risks: z.boolean().default(true),
  /** Compose yield-anomalies section internally. Cheap-ish (one extra delivery query). Default: true. */
  include_yield_anomalies: z.boolean().default(true),
  /** Compose inventory-forecast highlights internally. More expensive (per-ad-unit forecasts). Default: false. */
  include_inventory_forecast: z.boolean().default(false),
  /** Compose governance/audit-issue summary internally. Backend-dependent; default false. */
  include_governance: z.boolean().default(false),
});
export type MorningBriefingRequest = z.infer<typeof morningBriefingRequestSchema>;

export const morningBriefingResponseSchema = z.object({
  period: dateRangeSchema,
  executive_summary: z.string(),
  revenue_and_delivery: z.object({
    impressions: z.number().nullish(),
    revenue_gross: z.number().nullish(),
    revenue_net: z.number().nullish(),
    ecpm_gross: z.number().nullish(),
    ecpm_net: z.number().nullish(),
    fill_rate: z.number().nullish(),
    ctr: z.number().nullish(),
    top_ad_units: z.array(z.object({
      name: z.string(),
      impressions: z.number().nullish(),
      revenue: z.number().nullish(),
      ecpm: z.number().nullish(),
      fill_rate: z.number().nullish(),
    })),
    ssp_breakdown: z.array(z.object({
      name: z.string(),
      impressions: z.number().nullish(),
      revenue: z.number().nullish(),
      ecpm: z.number().nullish(),
    })),
  }),
  pacing_risks: z.array(pacingAlertSchema).default([]),
  yield_anomalies: z.array(z.object({
    dimension_key: z.string(),
    metric: metricNameSchema,
    change_percent: z.number().nullable(),
    severity: severitySchema,
    headline: z.string(),
  })).default([]),
  inventory_forecast_highlights: z.array(z.string()).default([]),
  governance_audit_issues: z.array(z.string()).default([]),
  data_quality_caveats: z.array(dataQualityWarningSchema).default([]),
  recommended_actions: z.array(z.string()).default([]),
  generated_at: isoDatetime,
});
export type MorningBriefingResponse = z.infer<typeof morningBriefingResponseSchema>;

// get_yield_anomalies
export const yieldAnomaliesRequestSchema = z.object({
  lookbackDays: z.number().int().min(2).max(60).default(14),
  dimensions: z.array(dimensionNameSchema).default(['ad_unit']),
  minImpressions: z.number().nonnegative().default(1000),
});
export type YieldAnomaliesRequest = z.infer<typeof yieldAnomaliesRequestSchema>;

export const yieldAnomalySchema = z.object({
  dimension_key: z.string(),
  dimensions: z.record(z.string(), z.string()).default({}),
  metric: metricNameSchema,
  baseline_value: z.number().nullable(),
  recent_value: z.number().nullable(),
  change_percent: z.number().nullable(),
  severity: severitySchema,
  hypotheses: z.array(hypothesisSchema).default([]),
  contribution_to_total_change_pct: z.number().nullish(),
  warnings: z.array(dataQualityWarningSchema).default([]),
});
export type YieldAnomaly = z.infer<typeof yieldAnomalySchema>;

export const yieldAnomaliesResponseSchema = z.object({
  anomalies: z.array(yieldAnomalySchema),
  total: z.number().int().nonnegative(),
  periods: z.object({
    baseline: dateRangeSchema,
    recent: dateRangeSchema,
  }),
  warnings: z.array(dataQualityWarningSchema).default([]),
  generated_at: isoDatetime,
});
export type YieldAnomaliesResponse = z.infer<typeof yieldAnomaliesResponseSchema>;

// get_inventory_forecast
export const inventoryForecastRequestSchema = z.object({
  adUnit: z.string(),
  startDate: dateString,
  endDate: dateString,
});
export type InventoryForecastRequest = z.infer<typeof inventoryForecastRequestSchema>;

/**
 * Confidence interval for a forecast value. The interval is metric-specific —
 * an interval for impressions cannot be reused as an interval for revenue
 * because revenue variance depends on both impression variance and eCPM
 * variance, which are independent.
 */
export const confidenceIntervalSchema = z.object({
  level: z.number().min(0).max(1).describe('Probability the true value falls in [low, high], e.g. 0.8 for 80%'),
  low: z.number().nullable(),
  high: z.number().nullable(),
});

export const inventoryForecastResponseSchema = z.object({
  ad_unit: z.string(),
  forecast_period: z.object({
    start: dateString,
    end: dateString,
    days: z.number().int().positive(),
  }),
  basis: z.enum(['historical_delivery', 'true_availability_unknown']),
  projected_impressions: z.number().nullable(),
  available_impressions: z.number().nullable(),
  projected_revenue: z.number().nullable(),
  confidence: confidenceLevelSchema,
  /**
   * 80% confidence interval on **projected_impressions only**, derived from
   * impressions-per-day sample variance over the history window. This is NOT
   * a revenue confidence interval — see `revenue_confidence_interval`.
   */
  impressions_confidence_interval: confidenceIntervalSchema.optional(),
  /**
   * 80% confidence interval on **projected_revenue**, derived from
   * revenue-per-day sample variance. Present only when the history window
   * contained enough revenue samples (≥ 3 days with non-null revenue);
   * otherwise omitted. NOT computed by combining impressions CI with eCPM —
   * computed directly from per-day revenue.
   */
  revenue_confidence_interval: confidenceIntervalSchema.optional(),
  inputs: z.object({
    history_days: z.number().int().nonnegative(),
    avg_daily_requests: z.number().nullable(),
    avg_fill_rate: z.number().nullable(),
    avg_ecpm: z.number().nullable(),
  }),
  caveats: z.array(z.string()).default([]),
  warnings: z.array(dataQualityWarningSchema).default([]),
  generated_at: isoDatetime,
});
export type InventoryForecastResponse = z.infer<typeof inventoryForecastResponseSchema>;

// compare_periods
export const comparePeriodsRequestSchema = z.object({
  metric: z.enum(['impressions', 'revenue', 'ecpm', 'ctr', 'fill_rate']),
  periodA: dateRangeSchema,
  periodB: dateRangeSchema,
  dimension: dimensionNameSchema.optional(),
});
export type ComparePeriodsRequest = z.infer<typeof comparePeriodsRequestSchema>;

export const comparePeriodsResponseSchema = z.object({
  metric: z.string(),
  dimension: z.string().nullable(),
  period_a: dateRangeSchema.extend({ value: z.number().nullable() }),
  period_b: dateRangeSchema.extend({ value: z.number().nullable() }),
  delta: z.number().nullable(),
  delta_percent: z.number().nullable(),
  trend: z.enum(['up', 'down', 'flat', 'unknown']),
  rows: z.array(z.object({
    dimension_value: z.string(),
    period_a: z.number().nullable(),
    period_b: z.number().nullable(),
    delta: z.number().nullable(),
    delta_percent: z.number().nullable(),
    trend: z.enum(['up', 'down', 'flat', 'unknown']),
  })).default([]),
  warnings: z.array(dataQualityWarningSchema).default([]),
  generated_at: isoDatetime,
});
export type ComparePeriodsResponse = z.infer<typeof comparePeriodsResponseSchema>;

// generate_visualization
export const visualizationRequestSchema = z.object({
  chartType: z.enum(['line', 'bar', 'area', 'pie']),
  title: z.string(),
  description: z.string().optional(),
  data: z.string().describe('JSON-encoded array of records'),
  xKey: z.string(),
  series: z.array(z.object({
    key: z.string(),
    label: z.string(),
    color: z.string().optional(),
  })).min(1),
});
export type VisualizationRequest = z.infer<typeof visualizationRequestSchema>;

export const visualizationResponseSchema = z.object({
  __type: z.literal('adcp_chart'),
  chart_type: z.enum(['line', 'bar', 'area', 'pie']),
  title: z.string(),
  description: z.string().optional(),
  data: z.array(z.record(z.string(), z.unknown())),
  x_key: z.string(),
  series: z.array(z.object({
    key: z.string(),
    label: z.string(),
    color: z.string().optional(),
  })),
});
export type VisualizationResponse = z.infer<typeof visualizationResponseSchema>;

// get_plan_audit_logs
export const planAuditLogsRequestSchema = z.object({
  mediaBuyId: z.string().optional(),
  planId: z.string().optional(),
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type PlanAuditLogsRequest = z.infer<typeof planAuditLogsRequestSchema>;

export const planAuditLogEntrySchema = z.object({
  id: z.string(),
  timestamp: isoDatetime,
  media_buy_id: z.string().nullish(),
  plan_id: z.string().nullish(),
  action: z.string(),
  actor: z.string(),
  actor_type: z.enum(['agent', 'human']),
  outcome: z.enum(['success', 'failure', 'pending']),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type PlanAuditLogEntry = z.infer<typeof planAuditLogEntrySchema>;

export const planAuditLogsResponseSchema = z.object({
  summary: z.object({
    total: z.number().int().nonnegative(),
    by_outcome: z.record(z.string(), z.number()),
    by_actor_type: z.record(z.string(), z.number()),
  }),
  logs: z.array(planAuditLogEntrySchema),
  warnings: z.array(dataQualityWarningSchema).default([]),
  generated_at: isoDatetime,
});
export type PlanAuditLogsResponse = z.infer<typeof planAuditLogsResponseSchema>;
