import { z } from 'zod';
import type { DataClient, DeliveryDimension } from '../data-client.js';

const VALID_DIMENSIONS: DeliveryDimension[] = ['date', 'ad_unit', 'order', 'line_item', 'device', 'country', 'ssp'];

export const deliverySummarySchema = z.object({
  startDate: z.string().describe('Start date (YYYY-MM-DD)'),
  endDate: z.string().describe('End date (YYYY-MM-DD)'),
  dimensions: z.array(z.enum(['date', 'ad_unit', 'order', 'line_item', 'device', 'country', 'ssp']))
    .default(['date'])
    .describe('Dimensions to group by. Use "ssp" for multi-SSP breakdown, "ad_unit" for placement analysis.'),
});

export const deliverySummaryTool = {
  name: 'get_delivery_summary',
  description: `Flexible delivery report across any combination of dimensions.
Supports grouping by: date, ad_unit, order, line_item, device, country, ssp (buyer network).
Use "ssp" dimension to compare performance across SSPs/demand sources.
Works for all campaigns regardless of whether they were booked via AdCP.`,
  inputSchema: {
    type: 'object' as const,
    required: ['startDate', 'endDate'],
    properties: {
      startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      dimensions: {
        type: 'array',
        items: { type: 'string', enum: VALID_DIMENSIONS },
        description: 'Dimensions to group by (default: ["date"])',
      },
    },
  },
};

export async function handleGetDeliverySummary(client: DataClient, args: z.infer<typeof deliverySummarySchema>) {
  const rows = await client.getDeliveryReport({
    startDate: args.startDate,
    endDate: args.endDate,
    dimensions: args.dimensions,
  });

  const totals = rows.reduce((acc, r) => ({
    impressions: acc.impressions + r.impressions,
    clicks: acc.clicks + r.clicks,
    revenue: acc.revenue + r.revenue,
    totalRequests: acc.totalRequests + r.totalRequests,
  }), { impressions: 0, clicks: 0, revenue: 0, totalRequests: 0 });

  const summary = {
    ...totals,
    ecpm: totals.impressions > 0 ? (totals.revenue / totals.impressions) * 1000 : 0,
    ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
    fillRate: totals.totalRequests > 0 ? totals.impressions / totals.totalRequests : 0,
  };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ summary, rows, rowCount: rows.length, fetchedAt: new Date().toISOString() }, null, 2),
    }],
  };
}
