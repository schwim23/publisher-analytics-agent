import type { DataClient } from '../data-client.js';
import {
  deliverySummaryRequestSchema,
  deliverySummaryResponseSchema,
  type DeliverySummaryRequest,
  type DeliveryMetricRow,
  type DataQualityWarning,
} from '../extension/schemas.js';
import {
  pickNumber, sumOptional, computeEcpm, rowRevenue, rowFillRate, rowAdRequests,
} from '../extension/metric-helpers.js';
import { structured, fmtNum, fmtMoney, fmtPct } from '../extension/tool-result.js';

export const deliverySummarySchema = deliverySummaryRequestSchema;

export const deliverySummaryTool = {
  name: 'get_delivery_summary',
  description: `Flexible delivery report across any combination of dimensions.
Supports grouping by: date, ad_unit, order, line_item, device, country, ssp, bidder, deal_id, placement, format, geo, content_category, demand_channel.
Use "ssp" dimension to compare across SSPs/demand sources.
Returns null for metrics the backend doesn't expose; check the warnings array for data-quality caveats.`,
  inputSchema: {
    type: 'object' as const,
    required: ['startDate', 'endDate'],
    properties: {
      startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      dimensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Dimensions to group by (default: ["date"])',
      },
      filter: { type: 'string', description: 'Optional backend-specific filter string' },
    },
  },
};

export async function handleGetDeliverySummary(client: DataClient, args: DeliverySummaryRequest) {
  const rows = await client.getDeliveryReport({
    startDate: args.startDate,
    endDate: args.endDate,
    dimensions: args.dimensions as ReadonlyArray<DeliverySummaryRequest['dimensions'][number]> as any,
    filter: args.filter,
  });

  const metricRows: DeliveryMetricRow[] = rows.map((r) => {
    const rev = rowRevenue(r);
    return {
      dimensions: r.dimensions ?? {},
      ad_requests: rowAdRequests(r),
      matched_requests: r.matched_requests ?? null,
      unfilled_requests: r.unfilled_requests ?? null,
      bid_requests: r.bid_requests ?? null,
      bid_responses: r.bid_responses ?? null,
      impressions: r.impressions ?? null,
      viewable_impressions: r.viewable_impressions ?? null,
      clicks: r.clicks ?? null,
      revenue_gross: r.revenue_gross ?? (rev.kind === 'gross' || rev.kind === 'legacy' ? rev.value : null),
      revenue_net: r.revenue_net ?? (rev.kind === 'net' ? rev.value : null),
      buyer_spend: r.buyer_spend ?? (rev.kind === 'buyer_spend' ? rev.value : null),
      ecpm_gross: r.ecpm_gross ?? null,
      ecpm_net: r.ecpm_net ?? null,
      fill_rate: rowFillRate(r),
      match_rate: r.match_rate ?? null,
      ctr: r.ctr > 0 ? r.ctr / 100 : null,
      viewability_rate: r.viewability_rate ?? null,
      win_rate: r.win_rate ?? null,
      bid_rate: r.bid_rate ?? null,
      timeout_rate: r.timeout_rate ?? null,
      floor_price: r.floor_price ?? null,
      bidder: r.bidder ?? null,
      ssp: r.ssp ?? null,
      deal_id: r.deal_id ?? null,
      order_id: r.order_id ?? null,
      line_item_id: r.line_item_id ?? null,
      ad_unit: r.ad_unit ?? null,
      placement: r.placement ?? null,
      format: r.format ?? null,
      device: r.device ?? null,
      geo: r.geo ?? null,
      content_category: r.content_category ?? null,
      demand_channel: r.demand_channel ?? null,
      consent_status: r.consent_status ?? null,
      identity_present: r.identity_present ?? null,
      creative_status: r.creative_status ?? null,
      source_system: r.source_system ?? null,
      data_freshness_timestamp: r.data_freshness_timestamp ?? null,
      warnings: (r.warnings ?? []) as any,
      provenance: r.provenance,
    };
  });

  const totals = {
    impressions: sumOptional(metricRows.map((r) => r.impressions ?? null)),
    clicks: sumOptional(metricRows.map((r) => r.clicks ?? null)),
    revenue_gross: sumOptional(metricRows.map((r) => r.revenue_gross ?? null)),
    revenue_net: sumOptional(metricRows.map((r) => r.revenue_net ?? null)),
    buyer_spend: sumOptional(metricRows.map((r) => r.buyer_spend ?? null)),
    ecpm_gross: null as number | null,
    ecpm_net: null as number | null,
    ctr: null as number | null,
    fill_rate: null as number | null,
  };

  const totalImpressions = totals.impressions;
  const totalClicks = totals.clicks;
  const totalRequests = sumOptional(metricRows.map((r) => r.ad_requests ?? null));
  totals.ecpm_gross = computeEcpm(totals.revenue_gross, totalImpressions);
  totals.ecpm_net = computeEcpm(totals.revenue_net, totalImpressions);
  totals.ctr = totalImpressions !== null && totalImpressions > 0 && totalClicks !== null
    ? totalClicks / totalImpressions
    : null;
  totals.fill_rate = totalImpressions !== null && totalRequests !== null && totalRequests > 0
    ? totalImpressions / totalRequests
    : null;

  const warnings: DataQualityWarning[] = [];
  if (totals.fill_rate === null) {
    warnings.push({
      code: 'FILL_RATE_UNAVAILABLE',
      message: 'Aggregated fill rate is null because the backend did not provide ad_requests.',
      severity: 'warning',
    });
  }
  if (totals.revenue_gross === null && totals.revenue_net === null && totals.buyer_spend !== null) {
    warnings.push({
      code: 'REVENUE_FROM_BUYER_SPEND',
      message: 'No publisher revenue available; totals reported in buyer_spend only.',
      severity: 'warning',
    });
  }

  // Hoist row-level warnings up so the top-level warnings list is one-stop.
  for (const r of metricRows) {
    if (r.warnings) for (const w of r.warnings) warnings.push(w);
  }

  return structured({
    schema: deliverySummaryResponseSchema,
    data: {
      period: { start: args.startDate, end: args.endDate },
      dimensions: args.dimensions,
      totals,
      rows: metricRows,
      row_count: metricRows.length,
      warnings: dedupeWarnings(warnings),
      generated_at: new Date().toISOString(),
    },
    text: (parsed) => {
      const t = parsed.totals;
      const rev = pickNumber(t.revenue_net, t.revenue_gross, t.buyer_spend);
      return [
        `Delivery summary ${parsed.period.start} → ${parsed.period.end} (${parsed.row_count} rows)`,
        `  Impressions: ${fmtNum(t.impressions)}  Revenue: ${fmtMoney(rev)}  eCPM: ${fmtMoney(t.ecpm_net ?? t.ecpm_gross)}  Fill: ${fmtPct(t.fill_rate, { fromFraction: true })}  CTR: ${fmtPct(t.ctr, { fromFraction: true })}`,
        (parsed.warnings ?? []).length ? `  ⚠ ${(parsed.warnings ?? []).length} data-quality warning(s)` : '',
      ].filter(Boolean).join('\n');
    },
  });
}

function dedupeWarnings(warnings: DataQualityWarning[]): DataQualityWarning[] {
  const seen = new Set<string>();
  const out: DataQualityWarning[] = [];
  for (const w of warnings) {
    const key = `${w.code}|${w.affected_field ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}
