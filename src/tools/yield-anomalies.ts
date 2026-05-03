import { z } from 'zod';
import type { DataClient, DeliveryDimension } from '../data-client.js';
import type { DeliveryRow } from '../adcp/types.js';

export const yieldAnomaliesSchema = z.object({
  lookbackDays: z.number().int().min(2).max(60).default(14)
    .describe('Total lookback window in days. The period is split in half to compare recent vs baseline (default: 14 days = 7 vs 7).'),
  dimensions: z.array(z.enum(['ad_unit', 'ssp', 'device', 'country', 'order']))
    .default(['ad_unit'])
    .describe('Dimensions to analyse for anomalies. Use "ssp" to detect SSP-level drops.'),
  minImpressions: z.number().default(1000)
    .describe('Minimum impressions in baseline period to include in analysis (filters noise).'),
});

export const yieldAnomaliesTool = {
  name: 'get_yield_anomalies',
  description: `Detect unusual drops or spikes in yield metrics over a lookback window.
Splits the window into baseline and recent halves, compares eCPM, fill rate, revenue, and impressions.
Use dimensions: ["ssp"] to detect which SSPs are causing drops, ["ad_unit"] for placement issues.
Works across all demand sources — not limited to AdCP campaigns.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      lookbackDays: { type: 'number', description: 'Total lookback days, split 50/50 (default 14)' },
      dimensions: {
        type: 'array',
        items: { type: 'string', enum: ['ad_unit', 'ssp', 'device', 'country', 'order'] },
        description: 'Dimensions to analyse (default: ["ad_unit"])',
      },
      minImpressions: { type: 'number', description: 'Min impressions threshold (default 1000)' },
    },
  },
};

function inferCause(metric: string, ecpmDelta: number, fillDelta: number, impDelta: number): string {
  if (metric === 'ecpm') {
    if (fillDelta >= -5) return 'Demand-side pressure — buyer CPMs declined without inventory changes';
    return 'Concurrent fill and demand drop — possible ad serving issue or policy change';
  }
  if (metric === 'fill_rate') {
    if (ecpmDelta >= -5) return 'Increased unfilled requests — check floor prices or SSP connectivity';
    return 'Demand withdrew — floor prices may be above market or SSP lost buyers';
  }
  if (metric === 'revenue') {
    if (impDelta >= -5 && ecpmDelta < -10) return 'eCPM compression — demand weakened on this placement';
    if (ecpmDelta >= -5 && impDelta < -10) return 'Traffic/inventory drop — fewer available impressions';
    return 'Compound drop in both volume and price — investigate upstream';
  }
  return 'Unusual change detected — manual review recommended';
}

export async function handleGetYieldAnomalies(client: DataClient, args: z.infer<typeof yieldAnomaliesSchema>) {
  const halfDays = Math.floor(args.lookbackDays / 2);
  const now = new Date();
  const recentEnd = new Date(now); recentEnd.setDate(recentEnd.getDate() - 1);
  const recentStart = new Date(recentEnd); recentStart.setDate(recentStart.getDate() - halfDays + 1);
  const baselineEnd = new Date(recentStart); baselineEnd.setDate(baselineEnd.getDate() - 1);
  const baselineStart = new Date(baselineEnd); baselineStart.setDate(baselineStart.getDate() - halfDays + 1);

  const fmt = (d: Date) => d.toISOString().split('T')[0];

  const dimensions: DeliveryDimension[] = args.dimensions as DeliveryDimension[];
  const [recent, baseline] = await Promise.all([
    client.getDeliveryReport({ startDate: fmt(recentStart), endDate: fmt(recentEnd), dimensions }),
    client.getDeliveryReport({ startDate: fmt(baselineStart), endDate: fmt(baselineEnd), dimensions }),
  ]);

  function aggregate(rows: DeliveryRow[]): Map<string, { impressions: number; revenue: number; clicks: number; totalRequests: number }> {
    const map = new Map<string, { impressions: number; revenue: number; clicks: number; totalRequests: number }>();
    for (const row of rows) {
      const key = dimensions.map((d) => row.dimensions[d] ?? '').join('||');
      const existing = map.get(key) ?? { impressions: 0, revenue: 0, clicks: 0, totalRequests: 0 };
      map.set(key, {
        impressions: existing.impressions + row.impressions,
        revenue: existing.revenue + row.revenue,
        clicks: existing.clicks + row.clicks,
        totalRequests: existing.totalRequests + row.totalRequests,
      });
    }
    return map;
  }

  const recentAgg = aggregate(recent);
  const baselineAgg = aggregate(baseline);

  interface Anomaly {
    dimensionKey: string;
    metric: string;
    baselineValue: number;
    recentValue: number;
    changePercent: number;
    severity: 'critical' | 'warning';
    probableCause: string;
  }

  const anomalies: Anomaly[] = [];

  for (const [key, base] of baselineAgg) {
    if (base.impressions < args.minImpressions) continue;
    const rec = recentAgg.get(key);
    if (!rec) continue;

    const baseEcpm = base.impressions > 0 ? (base.revenue / base.impressions) * 1000 : 0;
    const recEcpm = rec.impressions > 0 ? (rec.revenue / rec.impressions) * 1000 : 0;
    const baseFill = base.totalRequests > 0 ? (base.impressions / base.totalRequests) * 100 : 0;
    const recFill = rec.totalRequests > 0 ? (rec.impressions / rec.totalRequests) * 100 : 0;
    const impDelta = base.impressions > 0 ? ((rec.impressions - base.impressions) / base.impressions) * 100 : 0;
    const revDelta = base.revenue > 0 ? ((rec.revenue - base.revenue) / base.revenue) * 100 : 0;
    const ecpmDelta = baseEcpm > 0 ? ((recEcpm - baseEcpm) / baseEcpm) * 100 : 0;
    const fillDelta = baseFill > 0 ? recFill - baseFill : 0;

    const checks: Array<[string, number, number, number]> = [
      ['ecpm', ecpmDelta, baseEcpm, recEcpm],
      ['fill_rate', fillDelta, baseFill, recFill],
      ['revenue', revDelta, base.revenue, rec.revenue],
    ];

    for (const [metric, delta, baseVal, recVal] of checks) {
      const threshold = metric === 'fill_rate' ? -10 : -15;
      if (delta < threshold) {
        anomalies.push({
          dimensionKey: key,
          metric,
          baselineValue: Math.round(baseVal * 100) / 100,
          recentValue: Math.round(recVal * 100) / 100,
          changePercent: Math.round(delta * 10) / 10,
          severity: delta < threshold * 2 ? 'critical' : 'warning',
          probableCause: inferCause(metric, ecpmDelta, fillDelta, impDelta),
        });
      }
    }
  }

  anomalies.sort((a, b) => a.changePercent - b.changePercent);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        anomalies,
        total: anomalies.length,
        periods: {
          baseline: { start: fmt(baselineStart), end: fmt(baselineEnd) },
          recent: { start: fmt(recentStart), end: fmt(recentEnd) },
        },
        fetchedAt: new Date().toISOString(),
      }, null, 2),
    }],
  };
}
