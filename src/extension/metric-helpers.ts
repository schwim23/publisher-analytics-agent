import type { DeliveryRow } from '../adcp/types.js';

/**
 * Null-safe metric helpers. Returns `null` whenever the underlying data is
 * insufficient (vs returning 0, which silently lies to consumers).
 */

export function pickNumber(...values: Array<number | null | undefined>): number | null {
  for (const v of values) {
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}

export function sumOptional(values: Array<number | null | undefined>): number | null {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}

export function safeDiv(num: number | null, den: number | null): number | null {
  if (num === null || den === null || den === 0) return null;
  return num / den;
}

/** eCPM = revenue / impressions * 1000 */
export function computeEcpm(revenue: number | null, impressions: number | null): number | null {
  return safeDiv(revenue !== null && impressions !== null && impressions > 0 ? revenue * 1000 : null, impressions);
}

/** Pick the most informative revenue value for a row, preferring net → gross → buyer spend → legacy. */
export function rowRevenue(r: DeliveryRow): { value: number | null; kind: 'net' | 'gross' | 'buyer_spend' | 'legacy' | 'unknown' } {
  if (r.revenue_net !== null && r.revenue_net !== undefined) return { value: r.revenue_net, kind: 'net' };
  if (r.revenue_gross !== null && r.revenue_gross !== undefined) return { value: r.revenue_gross, kind: 'gross' };
  if (r.buyer_spend !== null && r.buyer_spend !== undefined) return { value: r.buyer_spend, kind: 'buyer_spend' };
  if (Number.isFinite(r.revenue)) return { value: r.revenue, kind: 'legacy' };
  return { value: null, kind: 'unknown' };
}

/** Pick fill rate, preferring extended `fill_rate` (nullable) over legacy `fillRate` (number). */
export function rowFillRate(r: DeliveryRow): number | null {
  if (r.fill_rate !== null && r.fill_rate !== undefined) return r.fill_rate;
  if (r.fillRate > 0) return r.fillRate;
  return null;
}

/** Pick total / ad requests, preferring extended `ad_requests` over legacy `totalRequests`. */
export function rowAdRequests(r: DeliveryRow): number | null {
  if (r.ad_requests !== null && r.ad_requests !== undefined) return r.ad_requests;
  if (r.totalRequests > 0) return r.totalRequests;
  return null;
}

export function pctChange(baseline: number | null, recent: number | null): number | null {
  if (baseline === null || recent === null) return null;
  if (baseline === 0) return null;
  return ((recent - baseline) / baseline) * 100;
}
