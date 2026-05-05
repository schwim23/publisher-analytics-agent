export interface AdCPConfig {
  baseUrl: string;
  apiKey: string;
}

export interface MediaBuy {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'completed' | 'pending';
  budget: number;
  spend: number;
  impressions: number;
  clicks: number;
  startDate: string;
  endDate: string;
  publisherId?: string;
}

export interface DeliveryReport {
  mediaBuyId: string;
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  pacing: number;
}

export interface GovernanceResult {
  mediaBuyId: string;
  passed: boolean;
  violations: GovernanceViolation[];
}

export interface GovernanceViolation {
  rule: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface InventoryProduct {
  id: string;
  name: string;
  publisherId: string;
  publisherName: string;
  format: string;
  minCpm: number;
  availableImpressions: number;
  targeting?: Record<string, string[]>;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  mediaBuyId?: string;
  planId?: string;
  action: string;
  actor: string;
  actorType: 'agent' | 'human';
  outcome: 'success' | 'failure' | 'pending';
  details?: Record<string, unknown>;
}

export interface AdCPError {
  code: string;
  message: string;
}

/**
 * Canonical delivery row. The simple legacy fields (impressions, clicks, revenue,
 * ecpm, ctr, totalRequests, fillRate) are non-null for backward compat with tools
 * that don't yet handle missing values; backends without that data should use
 * `0` for volumes and either `0` or a synthetic value plus a `warnings` entry on
 * the row to signal "this is not real data."
 *
 * The richer optional fields are the preferred surface for new code — they
 * allow nulls where the source backend doesn't expose them, and carry
 * provenance + data-quality warnings so the agent can be honest about gaps.
 *
 * Field naming is intentionally a mix of camelCase (legacy) and snake_case
 * (new, matches the extension schemas). Future versions may consolidate.
 */
export interface DeliveryRow {
  dimensions: Record<string, string>;

  // Legacy required fields — keep filled in (use 0 + warnings if unavailable)
  impressions: number;
  clicks: number;
  revenue: number;
  ecpm: number;
  ctr: number;
  totalRequests: number;
  fillRate: number;

  // Volume — extended
  ad_requests?: number | null;
  matched_requests?: number | null;
  unfilled_requests?: number | null;
  bid_requests?: number | null;
  bid_responses?: number | null;
  viewable_impressions?: number | null;

  // Revenue with explicit semantics. Prefer these over `revenue` in new code.
  revenue_gross?: number | null;
  revenue_net?: number | null;
  buyer_spend?: number | null;
  ecpm_gross?: number | null;
  ecpm_net?: number | null;

  // Rates (nullable). Prefer these over the legacy `fillRate` / `ctr` numbers.
  fill_rate?: number | null;
  match_rate?: number | null;
  viewability_rate?: number | null;
  win_rate?: number | null;
  bid_rate?: number | null;
  timeout_rate?: number | null;

  // Pricing
  floor_price?: number | null;

  // Identifiers
  bidder?: string | null;
  ssp?: string | null;
  deal_id?: string | null;
  order_id?: string | null;
  line_item_id?: string | null;
  ad_unit?: string | null;
  placement?: string | null;
  format?: string | null;
  device?: string | null;
  geo?: string | null;
  content_category?: string | null;
  demand_channel?: string | null;

  // Compliance / context
  consent_status?: string | null;
  identity_present?: boolean | null;
  creative_status?: string | null;

  // Origin
  source_system?: string | null;
  data_freshness_timestamp?: string | null;
  warnings?: DataQualityWarningLite[];
  provenance?: ProvenanceLite;
}

/** Lightweight provenance record on raw `DeliveryRow`. The richer Zod-validated
 *  shape lives in `src/extension/schemas.ts` and is what tools emit. */
export interface ProvenanceLite {
  source_system: string;
  source_task?: string;
  source_field?: string;
  source_record_id?: string;
  fetched_at?: string;
  derivation?: string;
}

export interface DataQualityWarningLite {
  code: string;
  message: string;
  severity?: 'info' | 'warning' | 'critical';
  affected_field?: string;
  affected_count?: number;
}
