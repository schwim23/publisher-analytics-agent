import type { DataClient, DeliveryDimension } from '../data-client.js';
import {
  comparePeriodsRequestSchema,
  comparePeriodsResponseSchema,
  type ComparePeriodsRequest,
} from '../extension/schemas.js';
import { rowRevenue, rowFillRate, pctChange, sumOptional } from '../extension/metric-helpers.js';
import { structured, fmtNum, fmtPct } from '../extension/tool-result.js';

export const comparePeriodsSchema = comparePeriodsRequestSchema;

export const comparePeriodsTool = {
  name: 'compare_periods',
  description: 'Compare a single metric between two date ranges, optionally broken down by a dimension. Use for WoW, MoM, YoY, or any custom comparison. Handles missing data with null + warnings instead of fabricating zeros.',
  inputSchema: {
    type: 'object' as const,
    required: ['metric', 'periodA', 'periodB'],
    properties: {
      metric: { type: 'string', enum: ['impressions', 'revenue', 'ecpm', 'ctr', 'fill_rate'] },
      periodA: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, required: ['start', 'end'] },
      periodB: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, required: ['start', 'end'] },
      dimension: { type: 'string' },
    },
  },
};

function metricForRow(metric: string, r: Parameters<typeof rowRevenue>[0]): number | null {
  switch (metric) {
    case 'impressions': return r.impressions ?? null;
    case 'revenue': return rowRevenue(r).value;
    case 'ecpm': {
      const rev = rowRevenue(r).value;
      return rev !== null && r.impressions ? (rev / r.impressions) * 1000 : null;
    }
    case 'ctr':
      return r.impressions && r.impressions > 0 && r.clicks !== null && r.clicks !== undefined
        ? r.clicks / r.impressions
        : null;
    case 'fill_rate': return rowFillRate(r);
    default: return null;
  }
}

export async function handleComparePeriods(client: DataClient, args: ComparePeriodsRequest) {
  const dims: DeliveryDimension[] = args.dimension ? [args.dimension as DeliveryDimension] : [];

  const [rowsA, rowsB] = await Promise.all([
    client.getDeliveryReport({ startDate: args.periodA.start, endDate: args.periodA.end, dimensions: dims }),
    client.getDeliveryReport({ startDate: args.periodB.start, endDate: args.periodB.end, dimensions: dims }),
  ]);

  if (!args.dimension) {
    const valA = aggregateMetric(rowsA, args.metric);
    const valB = aggregateMetric(rowsB, args.metric);
    const delta = valA !== null && valB !== null ? valB - valA : null;
    const deltaPercent = pctChange(valA, valB);
    return structured({
      schema: comparePeriodsResponseSchema,
      data: {
        metric: args.metric,
        dimension: null,
        period_a: { ...args.periodA, value: valA },
        period_b: { ...args.periodB, value: valB },
        delta,
        delta_percent: deltaPercent,
        trend: trend(delta),
        rows: [],
        warnings: [],
        generated_at: new Date().toISOString(),
      },
      text: (parsed) => [
        `Compare ${parsed.metric}: ${args.periodA.start}→${args.periodA.end} vs ${args.periodB.start}→${args.periodB.end}`,
        `  A: ${fmtMetric(args.metric, parsed.period_a.value)}  B: ${fmtMetric(args.metric, parsed.period_b.value)}  Δ ${fmtPct(parsed.delta_percent)} (${parsed.trend})`,
      ].join('\n'),
    });
  }

  // By-dimension comparison
  const mapA = new Map<string, typeof rowsA[number]>(rowsA.map((r) => [r.dimensions?.[args.dimension!] ?? '', r]));
  const mapB = new Map<string, typeof rowsB[number]>(rowsB.map((r) => [r.dimensions?.[args.dimension!] ?? '', r]));
  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);

  const rows = [...allKeys].map((key) => {
    const a = mapA.get(key);
    const b = mapB.get(key);
    const valA = a ? metricForRow(args.metric, a) : null;
    const valB = b ? metricForRow(args.metric, b) : null;
    const delta = valA !== null && valB !== null ? valB - valA : null;
    const deltaPercent = pctChange(valA, valB);
    return {
      dimension_value: key || '(unknown)',
      period_a: valA,
      period_b: valB,
      delta,
      delta_percent: deltaPercent,
      trend: trend(delta),
    };
  }).sort((a, b) => (a.delta_percent ?? 0) - (b.delta_percent ?? 0));

  return structured({
    schema: comparePeriodsResponseSchema,
    data: {
      metric: args.metric,
      dimension: args.dimension,
      period_a: { ...args.periodA, value: null },
      period_b: { ...args.periodB, value: null },
      delta: null,
      delta_percent: null,
      trend: 'unknown',
      rows,
      warnings: [],
      generated_at: new Date().toISOString(),
    },
    text: (parsed) => {
      const top = (parsed.rows ?? []).slice(0, 5);
      return [
        `Compare ${parsed.metric} by ${parsed.dimension}: ${args.periodA.start}→${args.periodA.end} vs ${args.periodB.start}→${args.periodB.end}`,
        ...top.map((r) => `  ${r.dimension_value}: A=${fmtMetric(args.metric, r.period_a)} B=${fmtMetric(args.metric, r.period_b)} Δ ${fmtPct(r.delta_percent)} (${r.trend})`),
      ].join('\n');
    },
  });
}

function aggregateMetric(rows: Parameters<typeof rowRevenue>[0][], metric: string): number | null {
  if (metric === 'ecpm') {
    const totalRev = sumOptional(rows.map((r) => rowRevenue(r).value));
    const totalImps = sumOptional(rows.map((r) => r.impressions ?? null));
    return totalRev !== null && totalImps !== null && totalImps > 0 ? (totalRev / totalImps) * 1000 : null;
  }
  if (metric === 'ctr') {
    const totalImps = sumOptional(rows.map((r) => r.impressions ?? null));
    const totalClicks = sumOptional(rows.map((r) => r.clicks ?? null));
    return totalImps !== null && totalImps > 0 && totalClicks !== null ? totalClicks / totalImps : null;
  }
  if (metric === 'fill_rate') {
    const totalImps = sumOptional(rows.map((r) => r.impressions ?? null));
    const totalReqs = sumOptional(rows.map((r) => (r.ad_requests ?? null) ?? (r.totalRequests > 0 ? r.totalRequests : null)));
    return totalImps !== null && totalReqs !== null && totalReqs > 0 ? totalImps / totalReqs : null;
  }
  return sumOptional(rows.map((r) => metricForRow(metric, r)));
}

function trend(delta: number | null): 'up' | 'down' | 'flat' | 'unknown' {
  if (delta === null) return 'unknown';
  if (delta > 0) return 'up';
  if (delta < 0) return 'down';
  return 'flat';
}

function fmtMetric(metric: string, value: number | null): string {
  if (value === null) return '—';
  if (metric === 'fill_rate' || metric === 'ctr') return `${(value * 100).toFixed(2)}%`;
  if (metric === 'ecpm' || metric === 'revenue') return `$${value.toFixed(2)}`;
  return fmtNum(value);
}
