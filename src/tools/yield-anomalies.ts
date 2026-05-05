import type { DataClient, DeliveryDimension } from '../data-client.js';
import type { DeliveryRow } from '../adcp/types.js';
import {
  yieldAnomaliesRequestSchema,
  yieldAnomaliesResponseSchema,
  type YieldAnomaliesRequest,
  type YieldAnomaly,
  type Hypothesis,
  type DataQualityWarning,
  type MetricName,
} from '../extension/schemas.js';
import { rowRevenue, rowAdRequests, pctChange } from '../extension/metric-helpers.js';
import { structured } from '../extension/tool-result.js';

export const yieldAnomaliesSchema = yieldAnomaliesRequestSchema;

export const yieldAnomaliesTool = {
  name: 'get_yield_anomalies',
  description: `Detect unusual drops in yield metrics over a lookback window by comparing recent vs baseline halves of the period.
Reports anomalies as hypotheses (NOT verdicts) with confidence levels, supporting evidence, and recommended next checks.
Checks: traffic/impressions drop, fill/match rate drop, eCPM drop, bidder timeout spike, bid response rate drop, floor-price + fill-drop combo, consent/identity availability changes, creative approval problems.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      lookbackDays: { type: 'number', description: 'Total lookback days, split 50/50 (default 14)' },
      dimensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Dimensions to analyse (default: ["ad_unit"])',
      },
      minImpressions: { type: 'number', description: 'Min impressions threshold (default 1000)' },
    },
  },
};

interface AggregatedMetrics {
  impressions: number | null;
  ad_requests: number | null;
  clicks: number | null;
  revenue: number | null;
  bid_responses: number | null;
  bid_requests: number | null;
  timeout_count_estimate: number | null;
  fill_rate: number | null;
  ecpm: number | null;
  bid_rate: number | null;
  floor_price_avg: number | null;
  consent_present: number | null;
  consent_total: number | null;
  identity_present: number | null;
  identity_total: number | null;
  creative_problems: number;
  raw_dims: Record<string, string>;
}

const DROP_THRESHOLDS: Record<string, { warning: number; critical: number }> = {
  ecpm: { warning: -15, critical: -30 },
  fill_rate: { warning: -10, critical: -20 },
  match_rate: { warning: -10, critical: -20 },
  impressions: { warning: -20, critical: -40 },
  revenue: { warning: -15, critical: -30 },
  bid_rate: { warning: -15, critical: -30 },
  timeout_rate: { warning: 50, critical: 100 }, // increases bad
};

export async function handleGetYieldAnomalies(client: DataClient, args: YieldAnomaliesRequest) {
  const halfDays = Math.floor(args.lookbackDays / 2);
  const now = new Date();
  const recentEnd = new Date(now); recentEnd.setUTCDate(recentEnd.getUTCDate() - 1);
  const recentStart = new Date(recentEnd); recentStart.setUTCDate(recentStart.getUTCDate() - halfDays + 1);
  const baselineEnd = new Date(recentStart); baselineEnd.setUTCDate(baselineEnd.getUTCDate() - 1);
  const baselineStart = new Date(baselineEnd); baselineStart.setUTCDate(baselineStart.getUTCDate() - halfDays + 1);
  const fmt = (d: Date) => d.toISOString().split('T')[0];

  const dimensions = args.dimensions as DeliveryDimension[];
  const [recent, baseline] = await Promise.all([
    client.getDeliveryReport({ startDate: fmt(recentStart), endDate: fmt(recentEnd), dimensions }),
    client.getDeliveryReport({ startDate: fmt(baselineStart), endDate: fmt(baselineEnd), dimensions }),
  ]);

  const recentAgg = aggregate(recent, dimensions);
  const baselineAgg = aggregate(baseline, dimensions);

  const anomalies: YieldAnomaly[] = [];
  const totalRevenueChange = computeTotalRevenueChange(baselineAgg, recentAgg);

  for (const [key, base] of baselineAgg) {
    if ((base.impressions ?? 0) < args.minImpressions) continue;
    const rec = recentAgg.get(key);
    if (!rec) continue;

    const dimsObj: Record<string, string> = base.raw_dims;

    const checks: Array<{ metric: MetricName; baseline: number | null; recent: number | null }> = [
      { metric: 'ecpm', baseline: base.ecpm, recent: rec.ecpm },
      { metric: 'fill_rate', baseline: base.fill_rate, recent: rec.fill_rate },
      { metric: 'impressions', baseline: base.impressions, recent: rec.impressions },
      { metric: 'revenue', baseline: base.revenue, recent: rec.revenue },
      { metric: 'bid_rate', baseline: base.bid_rate, recent: rec.bid_rate },
    ];

    for (const c of checks) {
      const change = pctChange(c.baseline, c.recent);
      if (change === null) continue;
      const thr = DROP_THRESHOLDS[c.metric];
      if (!thr) continue;
      if (change >= thr.warning) continue; // not a drop large enough to flag
      const severity = change <= thr.critical ? 'critical' : 'warning';
      const anomaly: YieldAnomaly = {
        dimension_key: key,
        dimensions: dimsObj,
        metric: c.metric,
        baseline_value: round2(c.baseline),
        recent_value: round2(c.recent),
        change_percent: round1(change),
        severity,
        hypotheses: buildHypotheses(c.metric, base, rec, change),
        contribution_to_total_change_pct: c.metric === 'revenue' && totalRevenueChange.baseTotal && Number.isFinite(totalRevenueChange.delta)
          ? round1(((rec.revenue ?? 0) - (base.revenue ?? 0)) / Math.abs(totalRevenueChange.delta || 1) * 100)
          : null,
        warnings: [],
      };
      anomalies.push(anomaly);
    }

    // Compound checks
    const fillDelta = pctChange(base.fill_rate, rec.fill_rate);
    const floorDelta = pctChange(base.floor_price_avg, rec.floor_price_avg);
    if (fillDelta !== null && fillDelta < -5 && floorDelta !== null && floorDelta > 5) {
      anomalies.push({
        dimension_key: key,
        dimensions: dimsObj,
        metric: 'fill_rate',
        baseline_value: round2(base.fill_rate),
        recent_value: round2(rec.fill_rate),
        change_percent: round1(fillDelta),
        severity: 'warning',
        hypotheses: [{
          label: 'Floor-price increase causing fill drop',
          confidence: 'medium',
          evidence: [
            `Floor price up ${round1(floorDelta)}% in recent period.`,
            `Fill rate down ${round1(fillDelta)}% in recent period.`,
          ],
          recommended_next_checks: [
            'Reduce floor prices on this dimension and re-measure.',
            'Confirm SSP/exchange floor enforcement is intact (i.e., floors didn\'t change at the SSP layer too).',
          ],
        }],
        warnings: [],
      });
    }

    // Timeout-rate spike (using bid_rate proxy if timeout_rate not directly given)
    const timeoutDelta = pctChange(base.timeout_count_estimate, rec.timeout_count_estimate);
    if (timeoutDelta !== null && timeoutDelta > 50) {
      anomalies.push({
        dimension_key: key,
        dimensions: dimsObj,
        metric: 'timeout_rate',
        baseline_value: round2(base.timeout_count_estimate),
        recent_value: round2(rec.timeout_count_estimate),
        change_percent: round1(timeoutDelta),
        severity: timeoutDelta > 100 ? 'critical' : 'warning',
        hypotheses: [{
          label: 'Bidder timeout spike',
          confidence: 'low',
          evidence: [`Estimated timeout count up ${round1(timeoutDelta)}% recent vs baseline.`],
          recommended_next_checks: [
            'Inspect SSP latency dashboards.',
            'Check for any header-bidding wrapper or timeout setting changes.',
          ],
        }],
        warnings: [],
      });
    }

    // Consent / identity availability changes
    if (base.consent_total && rec.consent_total) {
      const baseRate = (base.consent_present ?? 0) / base.consent_total;
      const recRate = (rec.consent_present ?? 0) / rec.consent_total;
      const consentDelta = pctChange(baseRate, recRate);
      if (consentDelta !== null && Math.abs(consentDelta) > 10) {
        anomalies.push({
          dimension_key: key,
          dimensions: dimsObj,
          metric: 'fill_rate',
          baseline_value: round2(baseRate),
          recent_value: round2(recRate),
          change_percent: round1(consentDelta),
          severity: 'warning',
          hypotheses: [{
            label: `${consentDelta < 0 ? 'Drop' : 'Rise'} in consent availability`,
            confidence: 'medium',
            evidence: [`Consent-present rate ${consentDelta < 0 ? 'down' : 'up'} ${round1(Math.abs(consentDelta))}% recent vs baseline.`],
            recommended_next_checks: ['Verify CMP behavior and traffic geo mix.'],
          }],
          warnings: [],
        });
      }
    }

    if (rec.creative_problems > base.creative_problems && rec.creative_problems > 0) {
      anomalies.push({
        dimension_key: key,
        dimensions: dimsObj,
        metric: 'fill_rate',
        baseline_value: null,
        recent_value: null,
        change_percent: null,
        severity: 'warning',
        hypotheses: [{
          label: 'Creative approval / status problems',
          confidence: 'medium',
          evidence: [`${rec.creative_problems} rows with non-OK creative_status in recent vs ${base.creative_problems} in baseline.`],
          recommended_next_checks: ['Open the affected line items in the ad server and resolve creative-approval issues.'],
        }],
        warnings: [],
      });
    }
  }

  // Sort anomalies by severity then largest negative change
  anomalies.sort((a, b) => {
    const sa = a.severity === 'critical' ? 0 : 1;
    const sb = b.severity === 'critical' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return (a.change_percent ?? 0) - (b.change_percent ?? 0);
  });

  const topWarnings: DataQualityWarning[] = [];
  if ([...recentAgg.values()].every((m) => m.fill_rate === null)) {
    topWarnings.push({ code: 'FILL_RATE_UNAVAILABLE', message: 'No fill-rate data available; fill-rate-based hypotheses are unreliable.', severity: 'warning' });
  }

  return structured({
    schema: yieldAnomaliesResponseSchema,
    data: {
      anomalies,
      total: anomalies.length,
      periods: {
        baseline: { start: fmt(baselineStart), end: fmt(baselineEnd) },
        recent: { start: fmt(recentStart), end: fmt(recentEnd) },
      },
      warnings: topWarnings,
      generated_at: new Date().toISOString(),
    },
    text: (parsed) => {
      if (parsed.total === 0) return 'No yield anomalies above threshold detected.';
      const top = parsed.anomalies.slice(0, 5);
      return [
        `${parsed.total} yield anomalies (recent ${parsed.periods.recent.start}→${parsed.periods.recent.end} vs baseline ${parsed.periods.baseline.start}→${parsed.periods.baseline.end})`,
        ...top.map((a) => `  ${a.severity.toUpperCase()} · ${a.metric} on ${a.dimension_key} ${a.change_percent !== null ? `${a.change_percent}%` : '—'} · ${(a.hypotheses ?? [])[0]?.label ?? '(no hypothesis)'}`),
      ].join('\n');
    },
  });
}

function aggregate(rows: DeliveryRow[], dimensions: DeliveryDimension[]): Map<string, AggregatedMetrics> {
  const map = new Map<string, AggregatedMetrics>();
  const floorSamples: Map<string, number[]> = new Map();
  for (const r of rows) {
    const dimsObj: Record<string, string> = {};
    for (const d of dimensions) dimsObj[d] = r.dimensions?.[d] ?? '';
    const key = dimensions.map((d) => dimsObj[d] ?? '').join('||');
    const cur = map.get(key) ?? emptyAgg(dimsObj);
    const rev = rowRevenue(r);
    cur.impressions = sumNullable(cur.impressions, r.impressions);
    cur.clicks = sumNullable(cur.clicks, r.clicks);
    cur.ad_requests = sumNullable(cur.ad_requests, rowAdRequests(r));
    cur.revenue = sumNullable(cur.revenue, rev.value);
    cur.bid_responses = sumNullable(cur.bid_responses, r.bid_responses ?? null);
    cur.bid_requests = sumNullable(cur.bid_requests, r.bid_requests ?? null);
    if (r.floor_price !== null && r.floor_price !== undefined && Number.isFinite(r.floor_price)) {
      const arr = floorSamples.get(key) ?? [];
      arr.push(r.floor_price);
      floorSamples.set(key, arr);
    }
    if (r.timeout_rate !== null && r.timeout_rate !== undefined && r.bid_requests !== null && r.bid_requests !== undefined) {
      cur.timeout_count_estimate = sumNullable(cur.timeout_count_estimate, r.timeout_rate * r.bid_requests);
    }
    if (r.consent_status) {
      cur.consent_total = (cur.consent_total ?? 0) + 1;
      if (r.consent_status === 'present' || r.consent_status === 'granted') {
        cur.consent_present = (cur.consent_present ?? 0) + 1;
      }
    }
    if (r.identity_present !== null && r.identity_present !== undefined) {
      cur.identity_total = (cur.identity_total ?? 0) + 1;
      if (r.identity_present) cur.identity_present = (cur.identity_present ?? 0) + 1;
    }
    if (r.creative_status && r.creative_status !== 'ok' && r.creative_status !== 'OK' && r.creative_status !== 'approved') {
      cur.creative_problems += 1;
    }
    map.set(key, cur);
  }
  // Compute derived rates per group
  for (const [key, v] of map) {
    v.ecpm = v.revenue !== null && v.impressions !== null && v.impressions > 0 ? (v.revenue / v.impressions) * 1000 : null;
    v.fill_rate = v.impressions !== null && v.ad_requests !== null && v.ad_requests > 0 ? v.impressions / v.ad_requests : null;
    v.bid_rate = v.bid_responses !== null && v.bid_requests !== null && v.bid_requests > 0 ? v.bid_responses / v.bid_requests : null;
    const floors = floorSamples.get(key);
    if (floors && floors.length > 0) v.floor_price_avg = floors.reduce((s, x) => s + x, 0) / floors.length;
  }
  return map;
}

function emptyAgg(dims: Record<string, string>): AggregatedMetrics {
  return {
    impressions: null, ad_requests: null, clicks: null, revenue: null,
    bid_responses: null, bid_requests: null,
    timeout_count_estimate: null, fill_rate: null, ecpm: null, bid_rate: null,
    floor_price_avg: null, consent_present: null, consent_total: null,
    identity_present: null, identity_total: null,
    creative_problems: 0, raw_dims: { ...dims },
  };
}

function sumNullable(a: number | null, b: number | null | undefined): number | null {
  if (a === null && (b === null || b === undefined)) return null;
  return (a ?? 0) + (b ?? 0);
}

function buildHypotheses(metric: MetricName, base: AggregatedMetrics, rec: AggregatedMetrics, changePct: number): Hypothesis[] {
  const fillDelta = pctChange(base.fill_rate, rec.fill_rate);
  const ecpmDelta = pctChange(base.ecpm, rec.ecpm);
  const impDelta = pctChange(base.impressions, rec.impressions);
  const out: Hypothesis[] = [];

  if (metric === 'ecpm') {
    if (fillDelta === null || Math.abs(fillDelta) < 5) {
      out.push({
        label: 'Demand-side eCPM compression without inventory change',
        confidence: 'medium',
        evidence: [
          `eCPM down ${round1(changePct)}%, fill ${fillDelta === null ? 'unknown' : `${round1(fillDelta)}%`}.`,
        ],
        recommended_next_checks: [
          'Compare bid landscape across SSPs for the same dimension.',
          'Check whether key buyers reduced bids or paused.',
        ],
      });
    } else {
      out.push({
        label: 'Concurrent fill and demand drop',
        confidence: 'low',
        evidence: [
          `eCPM down ${round1(changePct)}%, fill down ${round1(fillDelta)}%.`,
        ],
        recommended_next_checks: [
          'Investigate whether ad-server or SSP routing changed.',
          'Check timeout/error rates on affected slot.',
        ],
      });
    }
  } else if (metric === 'fill_rate') {
    if (ecpmDelta !== null && ecpmDelta < -5) {
      out.push({
        label: 'Demand withdrew on this dimension',
        confidence: 'medium',
        evidence: [`Fill down ${round1(changePct)}%, eCPM down ${round1(ecpmDelta)}% — both moving with each other suggests demand-side issue.`],
        recommended_next_checks: ['Check SSP partners for outage or policy change.', 'Confirm floor prices have not been raised.'],
      });
    } else {
      out.push({
        label: 'Increased unfilled requests',
        confidence: 'medium',
        evidence: [`Fill down ${round1(changePct)}%, eCPM ${ecpmDelta === null ? 'unknown' : `${round1(ecpmDelta)}%`}.`],
        recommended_next_checks: ['Verify floor pricing.', 'Inspect SSP connectivity / timeouts.'],
      });
    }
  } else if (metric === 'revenue') {
    if (impDelta !== null && impDelta > -5 && ecpmDelta !== null && ecpmDelta < -10) {
      out.push({
        label: 'eCPM compression dominating revenue drop',
        confidence: 'medium',
        evidence: [`Revenue down ${round1(changePct)}%, eCPM down ${round1(ecpmDelta)}%, impressions roughly flat.`],
        recommended_next_checks: ['Run a buyer-mix analysis to find the demand source.', 'Check yield-floor changes.'],
      });
    } else if (ecpmDelta !== null && ecpmDelta > -5 && impDelta !== null && impDelta < -10) {
      out.push({
        label: 'Volume drop dominating revenue change',
        confidence: 'medium',
        evidence: [`Revenue down ${round1(changePct)}%, impressions down ${round1(impDelta)}%, eCPM roughly flat.`],
        recommended_next_checks: ['Inspect site / app traffic for the dimension.', 'Check whether ad calls themselves dropped.'],
      });
    } else {
      out.push({
        label: 'Compound revenue drop',
        confidence: 'low',
        evidence: [`Revenue down ${round1(changePct)}% with both volume and eCPM moving.`],
        recommended_next_checks: ['Decompose by sub-dimension to find the dominant factor.', 'Check upstream traffic.'],
      });
    }
  } else if (metric === 'bid_rate') {
    out.push({
      label: 'Bid response rate dropped',
      confidence: 'low',
      evidence: [`Bid response rate down ${round1(changePct)}% (responses / requests).`],
      recommended_next_checks: ['Check SSP timeouts and fairness rules.', 'Look at active bidder count.'],
    });
  }

  if (out.length === 0) {
    out.push({
      label: 'Unusual change detected',
      confidence: 'low',
      evidence: [`${metric} changed ${round1(changePct)}% recent vs baseline.`],
      recommended_next_checks: ['Inspect raw data for the dimension before acting.'],
    });
  }
  return out;
}

function computeTotalRevenueChange(baseline: Map<string, AggregatedMetrics>, recent: Map<string, AggregatedMetrics>) {
  let baseTotal = 0; let recentTotal = 0;
  for (const v of baseline.values()) baseTotal += v.revenue ?? 0;
  for (const v of recent.values()) recentTotal += v.revenue ?? 0;
  return { baseTotal, recentTotal, delta: recentTotal - baseTotal };
}

function round1(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}
function round2(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}
