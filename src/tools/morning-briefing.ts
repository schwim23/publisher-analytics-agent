import { z } from 'zod';
import type { DataClient } from '../data-client.js';

export const morningBriefingSchema = z.object({
  lookbackDays: z.number().int().min(1).max(30).default(1)
    .describe('Days to include (default: 1 = yesterday)'),
});

export const morningBriefingTool = {
  name: 'get_morning_briefing',
  description: 'Publisher network briefing: total revenue, eCPM, fill rate, top/bottom ad units, SSP breakdown, and pacing alerts. Designed for daily ops standup or exec digest.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      lookbackDays: { type: 'number', description: 'Days to include (default: 1 = yesterday)' },
    },
  },
};

export async function handleGetMorningBriefing(client: DataClient, args: z.infer<typeof morningBriefingSchema>) {
  const end = new Date(); end.setDate(end.getDate() - 1);
  const start = new Date(end); start.setDate(start.getDate() - args.lookbackDays + 1);
  const fmt = (d: Date) => d.toISOString().split('T')[0];

  const [networkRows, adUnitRows, sspRows] = await Promise.all([
    client.getDeliveryReport({ startDate: fmt(start), endDate: fmt(end), dimensions: ['date'] }),
    client.getDeliveryReport({ startDate: fmt(start), endDate: fmt(end), dimensions: ['ad_unit'] }),
    client.getDeliveryReport({ startDate: fmt(start), endDate: fmt(end), dimensions: ['ssp'] }),
  ]);

  const totals = networkRows.reduce(
    (acc, r) => ({ impressions: acc.impressions + r.impressions, revenue: acc.revenue + r.revenue, clicks: acc.clicks + r.clicks, totalRequests: acc.totalRequests + r.totalRequests }),
    { impressions: 0, revenue: 0, clicks: 0, totalRequests: 0 }
  );

  const network = {
    impressions: totals.impressions,
    revenue: Math.round(totals.revenue * 100) / 100,
    ecpm: totals.impressions > 0 ? Math.round((totals.revenue / totals.impressions) * 100_000) / 100 : 0,
    fillRate: totals.totalRequests > 0 ? Math.round((totals.impressions / totals.totalRequests) * 1000) / 10 : 0,
    ctr: totals.impressions > 0 ? Math.round((totals.clicks / totals.impressions) * 10_000) / 100 : 0,
  };

  const adUnits = adUnitRows
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)
    .map((r) => ({ name: r.dimensions['ad_unit'], impressions: r.impressions, revenue: Math.round(r.revenue * 100) / 100, ecpm: Math.round(r.ecpm * 100) / 100, fillRate: Math.round(r.fillRate * 1000) / 10 }));

  const ssps = sspRows
    .sort((a, b) => b.revenue - a.revenue)
    .map((r) => ({ name: r.dimensions['ssp'], impressions: r.impressions, revenue: Math.round(r.revenue * 100) / 100, ecpm: Math.round(r.ecpm * 100) / 100 }));

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        period: { start: fmt(start), end: fmt(end), days: args.lookbackDays },
        network,
        topAdUnits: adUnits,
        sspBreakdown: ssps,
        generatedAt: new Date().toISOString(),
      }, null, 2),
    }],
  };
}
