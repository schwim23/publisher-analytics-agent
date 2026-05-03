import { z } from 'zod';
import type { DataClient, DeliveryDimension } from '../data-client.js';

export const comparePeriodsSchema = z.object({
  metric: z.enum(['impressions', 'revenue', 'ecpm', 'ctr', 'fill_rate'])
    .describe('Metric to compare'),
  periodA: z.object({ start: z.string(), end: z.string() }).describe('First period (e.g. last week)'),
  periodB: z.object({ start: z.string(), end: z.string() }).describe('Second period (e.g. this week)'),
  dimension: z.enum(['ad_unit', 'ssp', 'order', 'line_item', 'device', 'country']).optional()
    .describe('Optional: break the comparison down by this dimension'),
});

export const comparePeriodsTool = {
  name: 'compare_periods',
  description: 'Compare a metric between two time periods, optionally broken down by dimension. Use for WoW, MoM, or YoY analysis. Supports eCPM, fill rate, revenue, impressions, CTR.',
  inputSchema: {
    type: 'object' as const,
    required: ['metric', 'periodA', 'periodB'],
    properties: {
      metric: { type: 'string', enum: ['impressions', 'revenue', 'ecpm', 'ctr', 'fill_rate'] },
      periodA: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, required: ['start', 'end'] },
      periodB: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, required: ['start', 'end'] },
      dimension: { type: 'string', enum: ['ad_unit', 'ssp', 'order', 'line_item', 'device', 'country'] },
    },
  },
};

function extractMetric(row: { impressions: number; revenue: number; ecpm: number; ctr: number; fillRate: number }, metric: string): number {
  switch (metric) {
    case 'impressions': return row.impressions;
    case 'revenue': return row.revenue;
    case 'ecpm': return row.ecpm;
    case 'ctr': return row.ctr;
    case 'fill_rate': return row.fillRate;
    default: return 0;
  }
}

export async function handleComparePeriods(client: DataClient, args: z.infer<typeof comparePeriodsSchema>) {
  const dimensions: DeliveryDimension[] = args.dimension ? [args.dimension as DeliveryDimension] : [];

  const [rowsA, rowsB] = await Promise.all([
    client.getDeliveryReport({ startDate: args.periodA.start, endDate: args.periodA.end, dimensions }),
    client.getDeliveryReport({ startDate: args.periodB.start, endDate: args.periodB.end, dimensions }),
  ]);

  if (!args.dimension) {
    const sumMetric = (rows: typeof rowsA) => {
      if (['ecpm', 'ctr', 'fill_rate'].includes(args.metric)) {
        const totals = rows.reduce((acc, r) => ({ imp: acc.imp + r.impressions, rev: acc.rev + r.revenue, clicks: acc.clicks + r.clicks, req: acc.req + r.totalRequests }), { imp: 0, rev: 0, clicks: 0, req: 0 });
        if (args.metric === 'ecpm') return totals.imp > 0 ? (totals.rev / totals.imp) * 1000 : 0;
        if (args.metric === 'ctr') return totals.imp > 0 ? (totals.clicks / totals.imp) * 100 : 0;
        if (args.metric === 'fill_rate') return totals.req > 0 ? totals.imp / totals.req : 0;
      }
      return rows.reduce((s, r) => s + extractMetric(r, args.metric), 0);
    };

    const valA = sumMetric(rowsA);
    const valB = sumMetric(rowsB);
    const delta = valB - valA;
    const deltaPercent = valA !== 0 ? (delta / valA) * 100 : 0;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          metric: args.metric,
          periodA: { ...args.periodA, value: Math.round(valA * 100) / 100 },
          periodB: { ...args.periodB, value: Math.round(valB * 100) / 100 },
          delta: Math.round(delta * 100) / 100,
          deltaPercent: Math.round(deltaPercent * 10) / 10,
          trend: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
        }, null, 2),
      }],
    };
  }

  const mapA = new Map(rowsA.map((r) => [r.dimensions[args.dimension!] ?? '', r]));
  const mapB = new Map(rowsB.map((r) => [r.dimensions[args.dimension!] ?? '', r]));
  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);

  const rows = [...allKeys].map((key) => {
    const a = mapA.get(key);
    const b = mapB.get(key);
    const valA = a ? extractMetric(a, args.metric) : 0;
    const valB = b ? extractMetric(b, args.metric) : 0;
    const delta = valB - valA;
    return {
      [args.dimension!]: key,
      periodA: Math.round(valA * 100) / 100,
      periodB: Math.round(valB * 100) / 100,
      delta: Math.round(delta * 100) / 100,
      deltaPercent: valA !== 0 ? Math.round((delta / valA) * 1000) / 10 : null,
      trend: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    };
  }).sort((a, b) => (a.deltaPercent ?? 0) - (b.deltaPercent ?? 0));

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        metric: args.metric,
        dimension: args.dimension,
        periodA: args.periodA,
        periodB: args.periodB,
        rows,
      }, null, 2),
    }],
  };
}
