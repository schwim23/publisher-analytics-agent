import type { DataClient } from '../data-client.js';
import {
  morningBriefingRequestSchema,
  morningBriefingResponseSchema,
  type MorningBriefingRequest,
  type DataQualityWarning,
  type PacingAlert,
  type YieldAnomaly,
} from '../extension/schemas.js';
import {
  rowRevenue, rowFillRate, rowAdRequests, sumOptional, computeEcpm, pickNumber,
} from '../extension/metric-helpers.js';
import { structured, fmtNum, fmtMoney, fmtPct } from '../extension/tool-result.js';
import { handleGetPacingAlerts } from './pacing-alerts.js';
import { handleGetYieldAnomalies } from './yield-anomalies.js';
import { handleGetDealDiagnostics } from './deal-diagnostics.js';

export const morningBriefingSchema = morningBriefingRequestSchema;

export const morningBriefingTool = {
  name: 'get_morning_briefing',
  description: 'Sectioned publisher network briefing: executive summary, revenue+delivery snapshot, pacing risks, yield anomalies, inventory highlights, governance issues, data-quality caveats, recommended actions. Composes pacing + yield-anomaly sections inline by default. Designed for daily ops standup or exec digest.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      lookbackDays: { type: 'number', description: 'Days to include (default: 1 = yesterday)' },
      include_pacing_risks: { type: 'boolean', description: 'Populate pacing_risks section. Default: true.' },
      include_yield_anomalies: { type: 'boolean', description: 'Populate yield_anomalies section. Default: true.' },
      include_inventory_forecast: { type: 'boolean', description: 'Populate inventory_forecast_highlights. Default: false (more expensive).' },
      include_governance: { type: 'boolean', description: 'Populate governance_audit_issues. Default: false (backend-dependent).' },
      include_deal_diagnostics: { type: 'boolean', description: 'Populate deal_diagnostics summary. Default: false (backend-dependent).' },
      deal_ids: { type: 'array', items: { type: 'string' }, description: 'Restrict deal diagnostics to these deal IDs.' },
    },
  },
};

export async function handleGetMorningBriefing(client: DataClient, args: MorningBriefingRequest) {
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - args.lookbackDays + 1);
  const fmt = (d: Date) => d.toISOString().split('T')[0];

  const [networkRows, adUnitRows, sspRows] = await Promise.all([
    client.getDeliveryReport({ startDate: fmt(start), endDate: fmt(end), dimensions: ['date'] }),
    client.getDeliveryReport({ startDate: fmt(start), endDate: fmt(end), dimensions: ['ad_unit'] }),
    client.getDeliveryReport({ startDate: fmt(start), endDate: fmt(end), dimensions: ['ssp'] }),
  ]);

  const totalImpressions = sumOptional(networkRows.map((r) => r.impressions ?? null));
  const totalClicks = sumOptional(networkRows.map((r) => r.clicks ?? null));
  const totalAdRequests = sumOptional(networkRows.map((r) => rowAdRequests(r)));
  const totalRevenueGross = sumOptional(networkRows.map((r) => r.revenue_gross ?? null));
  const totalRevenueNet = sumOptional(networkRows.map((r) => r.revenue_net ?? null));
  const totalBuyerSpend = sumOptional(networkRows.map((r) => r.buyer_spend ?? null));
  const fallbackRevenue = pickNumber(
    totalRevenueNet,
    totalRevenueGross,
    totalBuyerSpend,
    sumOptional(networkRows.map((r) => Number.isFinite(r.revenue) ? r.revenue : null)),
  );

  const ecpmGross = computeEcpm(totalRevenueGross, totalImpressions);
  const ecpmNet = computeEcpm(totalRevenueNet, totalImpressions);
  const fillRate = totalImpressions !== null && totalAdRequests !== null && totalAdRequests > 0
    ? totalImpressions / totalAdRequests
    : null;
  const ctr = totalImpressions !== null && totalImpressions > 0 && totalClicks !== null
    ? totalClicks / totalImpressions
    : null;

  const topAdUnits = adUnitRows
    .map((r) => {
      const rev = rowRevenue(r);
      return {
        name: r.dimensions?.['ad_unit'] ?? r.ad_unit ?? '(unknown)',
        impressions: r.impressions ?? null,
        revenue: rev.value,
        ecpm: rev.value !== null && r.impressions ? (rev.value / r.impressions) * 1000 : null,
        fill_rate: rowFillRate(r),
      };
    })
    .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
    .slice(0, 10);

  const sspBreakdown = sspRows
    .map((r) => {
      const rev = rowRevenue(r);
      return {
        name: r.dimensions?.['ssp'] ?? r.ssp ?? '(unknown)',
        impressions: r.impressions ?? null,
        revenue: rev.value,
        ecpm: rev.value !== null && r.impressions ? (rev.value / r.impressions) * 1000 : null,
      };
    })
    .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0));

  // Aggregate row-level warnings
  const caveats: DataQualityWarning[] = [];
  for (const r of [...networkRows, ...adUnitRows, ...sspRows]) {
    if (r.warnings) for (const w of r.warnings) {
      if (!caveats.some((c) => c.code === w.code)) caveats.push(w as DataQualityWarning);
    }
  }
  if (fillRate === null) {
    caveats.push({
      code: 'FILL_RATE_UNAVAILABLE',
      message: 'Fill rate is null — backend did not provide ad request volume.',
      severity: 'warning',
    });
  }

  // Headline
  const headline = (() => {
    if (totalImpressions === null && fallbackRevenue === null) {
      return 'No delivery data available for this window — backend returned empty results. See data quality caveats.';
    }
    const parts: string[] = [];
    if (totalImpressions !== null) parts.push(`${fmtNum(totalImpressions)} impressions`);
    if (fallbackRevenue !== null) parts.push(`${fmtMoney(fallbackRevenue)} revenue`);
    if (ecpmNet !== null) parts.push(`${fmtMoney(ecpmNet)} eCPM (net)`);
    else if (ecpmGross !== null) parts.push(`${fmtMoney(ecpmGross)} eCPM (gross)`);
    if (fillRate !== null) parts.push(`${fmtPct(fillRate, { fromFraction: true })} fill`);
    return `${args.lookbackDays}d window ending ${fmt(end)}: ${parts.join(' · ')}.`;
  })();

  const recommendedActions: string[] = [];
  if (fillRate !== null && fillRate < 0.5) recommendedActions.push('Investigate low fill rate; check SSP connectivity and floor prices.');
  if (ecpmNet === null && ecpmGross === null) recommendedActions.push('Backend did not report publisher revenue; configure a revenue-aware data source for reliable yield analysis.');
  if (caveats.length > 3) recommendedActions.push(`Review ${caveats.length} data-quality caveats before acting on these numbers.`);

  // Internal section composition — call the underlying tool handlers so we
  // share their schema validation, hypothesis logic, and warning aggregation
  // without recursing through MCP. Failures degrade to caveats rather than
  // propagating up.
  let pacingRisks: PacingAlert[] = [];
  let yieldAnomalies: Array<{ dimension_key: string; metric: string; change_percent: number | null; severity: 'info' | 'warning' | 'critical'; headline: string }> = [];
  const inventoryHighlights: string[] = [];
  const governanceIssues: string[] = [];
  let dealDiagnosticsSummary: Array<{ deal_id: string; deal_name: string | null; deal_type: string; health_status: string; top_issue: string | null; severity: 'info' | 'warning' | 'critical' | null }> = [];

  if (args.include_pacing_risks) {
    try {
      const r = await handleGetPacingAlerts(client, { threshold: 0.8 });
      const sc = r.structuredContent as { alerts: PacingAlert[]; warnings?: DataQualityWarning[] };
      pacingRisks = sc.alerts;
      if (sc.warnings) for (const w of sc.warnings) {
        if (!caveats.some((c) => c.code === w.code)) caveats.push(w);
      }
    } catch (err) {
      caveats.push({
        code: 'BACKEND_FALLBACK',
        message: `Pacing-risks section failed to populate: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warning',
      });
    }
  }

  if (args.include_yield_anomalies) {
    try {
      const r = await handleGetYieldAnomalies(client, { lookbackDays: 14, dimensions: ['ad_unit'], minImpressions: 1000 });
      const sc = r.structuredContent as { anomalies: YieldAnomaly[]; warnings?: DataQualityWarning[] };
      // Map to the briefing's lighter shape.
      yieldAnomalies = sc.anomalies.slice(0, 10).map((a) => ({
        dimension_key: a.dimension_key,
        metric: a.metric,
        change_percent: a.change_percent,
        severity: a.severity,
        headline: (a.hypotheses && a.hypotheses[0]?.label) ?? `${a.metric} changed ${a.change_percent !== null ? `${a.change_percent}%` : ''} on ${a.dimension_key}`,
      }));
      if (sc.warnings) for (const w of sc.warnings) {
        if (!caveats.some((c) => c.code === w.code)) caveats.push(w);
      }
    } catch (err) {
      caveats.push({
        code: 'BACKEND_FALLBACK',
        message: `Yield-anomalies section failed to populate: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warning',
      });
    }
  }

  if (args.include_inventory_forecast) {
    // Highlight the top 3 ad units; brief 7-day projection. Skipped silently
    // when there are no ad units in the window.
    try {
      const { handleGetInventoryForecast } = await import('./inventory-forecast.js');
      const future = new Date(); future.setUTCDate(future.getUTCDate() + 1);
      const futureEnd = new Date(future); futureEnd.setUTCDate(futureEnd.getUTCDate() + 6);
      for (const u of topAdUnits.slice(0, 3)) {
        if (!u.name || u.name === '(unknown)') continue;
        const r = await handleGetInventoryForecast(client, { adUnit: u.name, startDate: fmt(future), endDate: fmt(futureEnd) });
        const sc = r.structuredContent as { projected_impressions: number | null; projected_revenue: number | null; ad_unit: string };
        if (sc.projected_impressions !== null) {
          inventoryHighlights.push(`${sc.ad_unit}: ~${fmtNum(sc.projected_impressions)} impressions / ${fmtMoney(sc.projected_revenue)} projected over the next 7 days`);
        }
      }
      if (inventoryHighlights.length === 0) {
        caveats.push({
          code: 'INSUFFICIENT_HISTORY',
          message: 'Inventory forecast requested but no ad units had enough history to project.',
          severity: 'info',
        });
      }
    } catch (err) {
      caveats.push({
        code: 'BACKEND_FALLBACK',
        message: `Inventory-forecast section failed to populate: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warning',
      });
    }
  }

  if (args.include_deal_diagnostics) {
    try {
      const r = await handleGetDealDiagnostics(client, {
        deal_ids: args.deal_ids,
        date_range: { start: fmt(start), end: fmt(end) },
        include_breakdown: false,
        min_severity: 'warning',
      });
      const sc = r.structuredContent as {
        deals: Array<{
          deal_id: string;
          deal_name: string | null;
          deal_type: string;
          health_status: string;
          issues: Array<{ hypothesis: string; severity: 'info' | 'warning' | 'critical' }>;
        }>;
        warnings?: DataQualityWarning[];
      };
      dealDiagnosticsSummary = sc.deals
        .filter((d) => d.health_status === 'critical' || d.health_status === 'at_risk')
        .slice(0, 10)
        .map((d) => ({
          deal_id: d.deal_id,
          deal_name: d.deal_name,
          deal_type: d.deal_type,
          health_status: d.health_status,
          top_issue: d.issues[0]?.hypothesis ?? null,
          severity: d.issues[0]?.severity ?? null,
        }));
      if (sc.warnings) for (const w of sc.warnings) {
        if (!caveats.some((c) => c.code === w.code)) caveats.push(w);
      }
    } catch (err) {
      caveats.push({
        code: 'BACKEND_FALLBACK',
        message: `Deal-diagnostics section failed to populate: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'info',
      });
    }
  }

  if (args.include_governance) {
    // Try a light governance check across active media buys. Skipped silently
    // when the backend doesn't expose listMediaBuys / checkGovernance.
    try {
      const buys = await client.listMediaBuys({ status: 'active' });
      for (const mb of buys.slice(0, 25)) {
        const r = await client.checkGovernance(mb.id);
        if (!r.passed) {
          for (const v of r.violations) {
            governanceIssues.push(`${mb.name} (${mb.id}): [${v.severity}] ${v.rule} — ${v.message}`);
          }
        }
      }
    } catch (err) {
      caveats.push({
        code: 'BACKEND_FALLBACK',
        message: `Governance section failed to populate: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'info',
      });
    }
  }

  return structured({
    schema: morningBriefingResponseSchema,
    data: {
      period: { start: fmt(start), end: fmt(end) },
      executive_summary: headline,
      revenue_and_delivery: {
        impressions: totalImpressions,
        revenue_gross: totalRevenueGross,
        revenue_net: totalRevenueNet,
        ecpm_gross: ecpmGross,
        ecpm_net: ecpmNet,
        fill_rate: fillRate,
        ctr: ctr,
        top_ad_units: topAdUnits,
        ssp_breakdown: sspBreakdown,
      },
      pacing_risks: pacingRisks,
      yield_anomalies: yieldAnomalies,
      inventory_forecast_highlights: inventoryHighlights,
      governance_audit_issues: governanceIssues,
      deal_diagnostics: dealDiagnosticsSummary,
      data_quality_caveats: caveats,
      recommended_actions: recommendedActions,
      generated_at: new Date().toISOString(),
    },
    text: (parsed) => {
      const r = parsed.revenue_and_delivery;
      const lines = [
        `📊 Morning briefing — ${parsed.period.start} → ${parsed.period.end}`,
        '',
        parsed.executive_summary,
        '',
        '## Revenue & delivery',
        `Impressions: ${fmtNum(r.impressions)}  Revenue (net): ${fmtMoney(r.revenue_net)}  Revenue (gross): ${fmtMoney(r.revenue_gross)}`,
        `eCPM (net): ${fmtMoney(r.ecpm_net)}  eCPM (gross): ${fmtMoney(r.ecpm_gross)}  Fill: ${fmtPct(r.fill_rate, { fromFraction: true })}  CTR: ${fmtPct(r.ctr, { fromFraction: true })}`,
      ];
      if (r.top_ad_units.length) {
        lines.push('', '## Top ad units (by revenue)');
        lines.push(...r.top_ad_units.slice(0, 5).map((u) => `  ${u.name} — imps ${fmtNum(u.impressions)}, rev ${fmtMoney(u.revenue)}, eCPM ${fmtMoney(u.ecpm)}`));
      }
      if (r.ssp_breakdown.length) {
        lines.push('', '## SSP mix (by revenue)');
        lines.push(...r.ssp_breakdown.slice(0, 5).map((s) => `  ${s.name} — imps ${fmtNum(s.impressions)}, rev ${fmtMoney(s.revenue)}, eCPM ${fmtMoney(s.ecpm)}`));
      }
      const actions = parsed.recommended_actions ?? [];
      if (actions.length) {
        lines.push('', '## Recommended actions');
        for (const a of actions) lines.push(`  • ${a}`);
      }
      const caveats = parsed.data_quality_caveats ?? [];
      if (caveats.length) {
        lines.push('', `⚠ ${caveats.length} data-quality caveat(s)`);
      }
      return lines.join('\n');
    },
  });
}
