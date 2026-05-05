import type { DataClient } from '../data-client.js';
import {
  dealDiagnosticsRequestSchema,
  dealDiagnosticsResponseSchema,
  type DealDiagnosticsRequest,
  type DealDiagnosticsEntry,
  type DealDiagnosticIssue,
  type DealMetricRow,
  type DealFunnel,
  type DealPacing,
  type DealHealthStatus,
  type Severity,
  type DataQualityWarning,
} from '../extension/schemas.js';
import { structured, fmtNum, fmtPct, fmtMoney } from '../extension/tool-result.js';

export const dealDiagnosticsSchema = dealDiagnosticsRequestSchema;

export const dealDiagnosticsTool = {
  name: 'get_deal_diagnostics',
  description: `Diagnose deal health across pacing, supply availability, bid response behavior, floor/bid mismatch, auction win rate, creative status, targeting constraints, SSP routing, and data quality.
Walks the deal auction funnel (eligible_ad_requests → deal_bid_requests → bid_responses → bids_above_floor → auction_wins → impressions), computes pacing if booked impressions/budget and flight dates exist, and emits diagnostic issues as **hypotheses** (NOT verdicts) with confidence, supporting evidence, recommended next checks, and recommended actions.
Backends without per-deal funnel data return DATA_INSUFFICIENT rather than fabricated metrics.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      deal_ids: { type: 'array', items: { type: 'string' }, description: 'Filter to these deals; omit to diagnose all returned' },
      date_range: {
        type: 'object',
        properties: { start: { type: 'string' }, end: { type: 'string' } },
        description: 'YYYY-MM-DD range; defaults to last 7 days ending yesterday',
      },
      include_breakdown: { type: 'boolean', description: 'Include per-dimension breakdowns (default false)' },
      min_severity: { type: 'string', enum: ['info', 'warning', 'critical'], description: 'Minimum issue severity to include (default info)' },
    },
  },
};

export async function handleGetDealDiagnostics(client: DataClient, args: DealDiagnosticsRequest) {
  const { startDate, endDate } = resolveDateRange(args.date_range);
  const generatedAt = new Date().toISOString();

  // Backend availability gate
  if (typeof client.getDealDiagnosticsData !== 'function') {
    return structured({
      schema: dealDiagnosticsResponseSchema,
      data: {
        period: { start: startDate, end: endDate },
        deals: [],
        total: 0,
        warnings: [{
          code: 'BACKEND_FALLBACK',
          message: 'This backend does not implement getDealDiagnosticsData; deal diagnostics are unavailable.',
          severity: 'warning',
        }],
        generated_at: generatedAt,
      },
      text: () => 'Deal diagnostics unavailable: backend has no per-deal funnel data.',
    });
  }

  const rows = await client.getDealDiagnosticsData({
    dealIds: args.deal_ids,
    startDate,
    endDate,
  });

  if (rows.length === 0) {
    return structured({
      schema: dealDiagnosticsResponseSchema,
      data: {
        period: { start: startDate, end: endDate },
        deals: [],
        total: 0,
        warnings: [{
          code: 'INSUFFICIENT_HISTORY',
          message: args.deal_ids?.length
            ? `No deal data returned for the requested deal_ids over ${startDate}..${endDate}.`
            : `No active deals returned over ${startDate}..${endDate}.`,
          severity: 'info',
        }],
        generated_at: generatedAt,
      },
      text: () => 'No deal data returned for this period.',
    });
  }

  const minSev = severityRank(args.min_severity);
  const entries: DealDiagnosticsEntry[] = rows.map((row) => buildEntry(row, startDate, endDate, args.include_breakdown, minSev));

  // Sort: critical → at_risk → healthy → no_data, then by issue count desc
  entries.sort((a, b) => {
    const ha = healthRank(a.health_status);
    const hb = healthRank(b.health_status);
    if (ha !== hb) return ha - hb;
    return b.issues.length - a.issues.length;
  });

  return structured({
    schema: dealDiagnosticsResponseSchema,
    data: {
      period: { start: startDate, end: endDate },
      deals: entries,
      total: entries.length,
      warnings: [],
      generated_at: generatedAt,
    },
    text: (parsed) => {
      const counts = parsed.deals.reduce<Record<string, number>>((acc, d) => {
        acc[d.health_status] = (acc[d.health_status] ?? 0) + 1;
        return acc;
      }, {});
      const top = parsed.deals.slice(0, 5);
      return [
        `Deal diagnostics for ${parsed.period.start} → ${parsed.period.end} (${parsed.total} deals)`,
        `  Health: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'no deals'}`,
        ...top.map((d) => `  ${d.health_status.toUpperCase()} · ${d.deal_name ?? d.deal_id} (${d.deal_type})${d.issues.length ? ` — ${d.issues[0].hypothesis}` : ''}`),
      ].join('\n');
    },
  });
}

/* ─────────────────────────────  Funnel + pacing  ───────────────────────── */

function buildEntry(row: DealMetricRow, startDate: string, endDate: string, includeBreakdowns: boolean, minSeverityRank: number): DealDiagnosticsEntry {
  const funnel = computeFunnel(row);
  const pacing = computePacing(row);
  const issues = collectIssues(row, funnel, pacing).filter((i) => severityRank(i.severity) <= minSeverityRank);
  const health = deriveHealth(issues, funnel);
  const warnings: DataQualityWarning[] = [...(row.warnings ?? [])];

  return {
    deal_id: row.deal_id,
    deal_name: row.deal_name ?? null,
    deal_type: row.deal_type ?? 'unknown',
    buyer: row.buyer ?? null,
    ssp: row.ssp ?? null,
    period: { start: startDate, end: endDate },
    health_status: health,
    funnel,
    pacing,
    issues,
    warnings,
    breakdowns: includeBreakdowns ? (row.breakdowns ?? []) : [],
    provenance: row.provenance,
  };
}

function computeFunnel(row: DealMetricRow): DealFunnel {
  const eligible = row.eligible_ad_requests ?? null;
  const dealReqs = row.deal_bid_requests ?? null;
  const responses = row.bid_responses ?? null;
  const validBids = row.valid_bids ?? null;
  const aboveFloor = row.bids_above_floor ?? null;
  const wins = row.auction_wins ?? null;
  const imps = row.impressions ?? null;

  return {
    eligible_ad_requests: eligible,
    deal_bid_requests: dealReqs,
    bid_responses: responses,
    valid_bids: validBids,
    bids_above_floor: aboveFloor,
    auction_wins: wins,
    impressions: imps,

    request_to_response_rate: prefer(row.bid_rate, safeRatio(responses, dealReqs)),
    response_to_above_floor_rate: prefer(row.above_floor_rate, safeRatio(aboveFloor, validBids ?? responses)),
    above_floor_to_win_rate: prefer(row.win_rate, safeRatio(wins, aboveFloor)),
    win_to_impression_rate: safeRatio(imps, wins),
  };
}

function computePacing(row: DealMetricRow): DealPacing | null {
  const flight = parseFlight(row.start_date, row.end_date);
  const elapsed = flight ? clamp01((Date.now() - flight.start) / (flight.end - flight.start)) : null;

  // Pick the most informative basis available
  let basis: DealPacing['basis'] = 'unknown';
  let pacingRatio: number | null = null;
  let spendRatio: number | null = null;

  if (row.booked_impressions && row.booked_impressions > 0 && row.impressions !== null && row.impressions !== undefined && elapsed !== null) {
    basis = 'booked_impressions';
    const expected = elapsed * row.booked_impressions;
    pacingRatio = expected > 0 ? row.impressions / expected : null;
  } else if (row.booked_revenue && row.booked_revenue > 0 && (row.revenue_net ?? row.revenue_gross ?? row.buyer_spend ?? null) !== null && elapsed !== null) {
    basis = 'booked_revenue';
    const realised = row.revenue_net ?? row.revenue_gross ?? row.buyer_spend ?? 0;
    const expected = elapsed * row.booked_revenue;
    pacingRatio = expected > 0 ? realised / expected : null;
    spendRatio = realised / row.booked_revenue;
  } else if (row.booked_budget && row.booked_budget > 0 && row.buyer_spend !== null && row.buyer_spend !== undefined) {
    basis = 'booked_budget';
    spendRatio = row.buyer_spend / row.booked_budget;
    if (elapsed !== null) {
      pacingRatio = elapsed > 0 ? spendRatio / elapsed : null;
    }
  }

  if (basis === 'unknown') return null;

  let confidence: DealPacing['confidence'] = 'low';
  if (basis === 'booked_impressions' && row.impressions !== null && row.impressions !== undefined) confidence = 'high';
  else if (basis === 'booked_revenue' && (row.revenue_net !== null && row.revenue_net !== undefined)) confidence = 'medium';

  return {
    pacing_ratio: pacingRatio,
    spend_ratio: spendRatio,
    elapsed_fraction: elapsed,
    on_track: pacingRatio === null ? null : pacingRatio >= 0.85 && pacingRatio <= 1.15,
    confidence,
    basis,
  };
}

/* ─────────────────────────────  Diagnostic rules  ──────────────────────── */

function collectIssues(row: DealMetricRow, funnel: DealFunnel, pacing: DealPacing | null): DealDiagnosticIssue[] {
  const issues: DealDiagnosticIssue[] = [];

  // 0. CREATIVE_BLOCKED — high signal, do first
  if (row.creative_status && /^(rejected|blocked|disapprov)/i.test(row.creative_status)) {
    issues.push({
      code: 'CREATIVE_BLOCKED',
      severity: 'critical',
      hypothesis: `Creative is ${row.creative_status}, blocking serving on this deal.`,
      confidence: 'high',
      evidence: [`creative_status = "${row.creative_status}"`],
      recommended_next_checks: [
        'Open the affected creative(s) in the ad server / SSP UI and inspect the rejection reason.',
        'Confirm whether the rejection is per-creative or per-buyer-line.',
      ],
      recommended_actions: [
        'Resolve the creative-approval issue (resubmit, fix policy violation, or swap creative).',
        'Pause delivery until creative is approved to avoid wasted requests.',
      ],
    });
  }

  // 1. SUPPLY_CONSTRAINT
  if (funnel.eligible_ad_requests !== null) {
    if (funnel.eligible_ad_requests === 0) {
      issues.push({
        code: 'SUPPLY_CONSTRAINT',
        severity: 'critical',
        hypothesis: 'No eligible ad requests reached this deal — the deal is starved of supply.',
        confidence: 'high',
        evidence: ['eligible_ad_requests = 0'],
        recommended_next_checks: [
          'Verify the deal\'s targeting (placement, geo, device, content) matches what the publisher actually serves.',
          'Confirm the deal is enabled on the SSP and not deactivated by the buyer.',
          'Check whether sister deals from the same buyer are receiving traffic.',
        ],
        recommended_actions: [
          'Loosen targeting constraints if too narrow.',
          'Re-confirm the SSP routing on both publisher and buyer side.',
        ],
      });
    } else if (row.booked_impressions && funnel.eligible_ad_requests < row.booked_impressions * 0.5) {
      issues.push({
        code: 'SUPPLY_CONSTRAINT',
        severity: 'warning',
        hypothesis: 'Eligible supply is well below booked goal — likely supply shortage on this deal.',
        confidence: 'medium',
        evidence: [
          `eligible_ad_requests=${fmtNum(funnel.eligible_ad_requests)} vs booked_impressions=${fmtNum(row.booked_impressions)}`,
        ],
        recommended_next_checks: [
          'Check whether targeting can be relaxed without breaking the deal contract.',
          'Look at site-level traffic trends for the targeted dimension.',
        ],
        recommended_actions: [
          'Negotiate a reduced booked target with the buyer if structural.',
          'Expand targeting (subject to deal terms).',
        ],
      });
    }
  }

  // 2. LOW_BID_RATE (request_to_response)
  if (funnel.request_to_response_rate !== null && funnel.deal_bid_requests !== null && funnel.deal_bid_requests > 100) {
    const sev: Severity | null =
      funnel.request_to_response_rate < 0.1 ? 'critical' :
      funnel.request_to_response_rate < 0.3 ? 'warning' : null;
    if (sev) {
      issues.push({
        code: 'LOW_BID_RATE',
        severity: sev,
        hypothesis: 'Buyer is responding to far fewer bid requests than expected.',
        confidence: 'medium',
        evidence: [
          `bid_responses / deal_bid_requests = ${fmtPct(funnel.request_to_response_rate, { fromFraction: true })} (responses=${fmtNum(funnel.bid_responses)}, requests=${fmtNum(funnel.deal_bid_requests)})`,
        ],
        recommended_next_checks: [
          'Confirm the buyer\'s bidder is healthy (timeout dashboards, error rates).',
          'Confirm targeting on the buyer side hasn\'t been narrowed.',
          'Check whether other deals from the same DSP show the same drop.',
        ],
        recommended_actions: [
          'Reach out to the buyer; share request fingerprints.',
          'If buyer-side bidder is degraded, consider routing fallback.',
        ],
      });
    }
  }

  // 3. FLOOR_MISMATCH
  if (row.floor_price !== null && row.floor_price !== undefined && row.avg_bid_cpm !== null && row.avg_bid_cpm !== undefined && row.avg_bid_cpm > 0) {
    const aboveFloorRate = funnel.response_to_above_floor_rate;
    if (row.floor_price > row.avg_bid_cpm * 1.05) {
      const sev: Severity = aboveFloorRate !== null && aboveFloorRate < 0.1 ? 'critical' : 'warning';
      issues.push({
        code: 'FLOOR_MISMATCH',
        severity: sev,
        hypothesis: 'Floor price is above the buyer\'s bid distribution; most bids are clipped.',
        confidence: 'high',
        evidence: [
          `floor_price=${fmtMoney(row.floor_price)} vs avg_bid_cpm=${fmtMoney(row.avg_bid_cpm)}`,
          aboveFloorRate !== null ? `above_floor_to_win path filters out ${fmtPct(1 - aboveFloorRate, { fromFraction: true })} of responses` : '',
        ].filter(Boolean),
        recommended_next_checks: [
          'Re-examine the deal\'s negotiated floor.',
          'Confirm the buyer\'s bid landscape on this deal.',
        ],
        recommended_actions: [
          'Lower the floor or renegotiate the deal CPM to align with the bid distribution.',
        ],
      });
    }
  }

  // 4. LOW_WIN_RATE (above_floor_to_win)
  if (funnel.above_floor_to_win_rate !== null && funnel.bids_above_floor !== null && funnel.bids_above_floor > 50) {
    const sev: Severity | null =
      funnel.above_floor_to_win_rate < 0.1 ? 'critical' :
      funnel.above_floor_to_win_rate < 0.3 ? 'warning' : null;
    if (sev) {
      issues.push({
        code: 'LOW_WIN_RATE',
        severity: sev,
        hypothesis: 'This deal is losing the auction to other demand even after clearing the floor.',
        confidence: 'medium',
        evidence: [
          `above_floor_to_win = ${fmtPct(funnel.above_floor_to_win_rate, { fromFraction: true })} (wins=${fmtNum(funnel.auction_wins)}, above_floor=${fmtNum(funnel.bids_above_floor)})`,
        ],
        recommended_next_checks: [
          'Inspect competing demand — is open exchange beating this deal?',
          'Check whether the deal is set as preferred in the auction logic.',
        ],
        recommended_actions: [
          'Promote this deal\'s priority in the auction logic.',
          'Discuss with buyer whether a higher bid is possible.',
        ],
      });
    }
  }

  // 5. UNDERPACING
  if (pacing && pacing.pacing_ratio !== null) {
    const sev: Severity | null =
      pacing.pacing_ratio < 0.5 ? 'critical' :
      pacing.pacing_ratio < 0.85 ? 'warning' : null;
    if (sev) {
      issues.push({
        code: 'UNDERPACING',
        severity: sev,
        hypothesis: `Deal is underpacing on a ${pacing.basis} basis.`,
        confidence: pacing.confidence,
        evidence: [
          `pacing_ratio=${(pacing.pacing_ratio * 100).toFixed(0)}% with elapsed_fraction=${pacing.elapsed_fraction !== null ? (pacing.elapsed_fraction * 100).toFixed(0) + '%' : 'unknown'}`,
        ],
        recommended_next_checks: [
          'Cross-check supply, bid response, and floor alignment (other diagnostics on this deal).',
          'Confirm flight dates are accurate.',
        ],
        recommended_actions: [
          'If the gap is recent, look at SSP/buyer-side breakage.',
          'If structural, renegotiate booked target.',
        ],
      });
    }
  }

  // 6. ROUTING_OR_SSP_ISSUE
  if (
    funnel.deal_bid_requests !== null && funnel.eligible_ad_requests !== null &&
    funnel.eligible_ad_requests > 100 && funnel.deal_bid_requests / funnel.eligible_ad_requests < 0.1
  ) {
    issues.push({
      code: 'ROUTING_OR_SSP_ISSUE',
      severity: 'warning',
      hypothesis: 'Eligible requests are not being sent to this deal\'s SSP/buyer — likely a routing or SSP-side filter.',
      confidence: 'medium',
      evidence: [
        `deal_bid_requests / eligible_ad_requests = ${fmtPct(funnel.deal_bid_requests / funnel.eligible_ad_requests, { fromFraction: true })} (deal=${fmtNum(funnel.deal_bid_requests)}, eligible=${fmtNum(funnel.eligible_ad_requests)})`,
      ],
      recommended_next_checks: [
        'Confirm the SSP is included in the publisher\'s wrapper / waterfall for the targeted inventory.',
        'Check whether other deals on the same SSP receive proportionate traffic.',
      ],
      recommended_actions: [
        'Inspect SSP-side eligibility rules and the publisher\'s ad-server routing.',
      ],
    });
  }

  // 7. DATA_INSUFFICIENT — only emit when key signal fields are missing
  if (
    funnel.eligible_ad_requests === null ||
    funnel.deal_bid_requests === null ||
    funnel.bid_responses === null
  ) {
    issues.push({
      code: 'DATA_INSUFFICIENT',
      severity: 'info',
      hypothesis: 'Diagnostics are limited — the backend did not return the full deal funnel.',
      confidence: 'high',
      evidence: [
        funnel.eligible_ad_requests === null ? 'eligible_ad_requests is null' : '',
        funnel.deal_bid_requests === null ? 'deal_bid_requests is null' : '',
        funnel.bid_responses === null ? 'bid_responses is null' : '',
      ].filter(Boolean),
      recommended_next_checks: [
        'Confirm your DataClient implementation populates the full funnel for this deal.',
        'Some SSPs only expose post-auction metrics; you may need to combine sources.',
      ],
      recommended_actions: [
        'Treat this deal\'s health as inconclusive until funnel data is available.',
      ],
    });
  }

  return issues;
}

function deriveHealth(issues: DealDiagnosticIssue[], funnel: DealFunnel): DealHealthStatus {
  const allFunnelMissing = funnel.eligible_ad_requests === null && funnel.deal_bid_requests === null && funnel.bid_responses === null && funnel.impressions === null;
  if (allFunnelMissing) return 'no_data';
  if (issues.some((i) => i.severity === 'critical')) return 'critical';
  if (issues.some((i) => i.severity === 'warning')) return 'at_risk';
  return 'healthy';
}

/* ─────────────────────────────  Helpers  ───────────────────────────────── */

function resolveDateRange(range: { start: string; end: string } | undefined): { startDate: string; endDate: string } {
  if (range) return { startDate: range.start, endDate: range.end };
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 6);
  return {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
  };
}

function safeRatio(num: number | null | undefined, den: number | null | undefined): number | null {
  if (num === null || num === undefined || den === null || den === undefined || den === 0) return null;
  return clamp01(num / den);
}

function prefer<T>(primary: T | null | undefined, fallback: T | null): T | null {
  return (primary !== null && primary !== undefined) ? primary : fallback;
}

function parseFlight(start?: string | null, end?: string | null): { start: number; end: number } | null {
  if (!start || !end) return null;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  return { start: s, end: e };
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function severityRank(s: Severity): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2;
}

function healthRank(h: DealHealthStatus): number {
  switch (h) {
    case 'critical': return 0;
    case 'at_risk': return 1;
    case 'healthy': return 2;
    case 'no_data': return 3;
  }
}
