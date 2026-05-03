import { z } from 'zod';
import type { DataClient } from '../data-client.js';

export const inventoryForecastSchema = z.object({
  adUnit: z.string().describe('Ad unit name to forecast'),
  startDate: z.string().describe('Forecast start date (YYYY-MM-DD)'),
  endDate: z.string().describe('Forecast end date (YYYY-MM-DD)'),
});

export const inventoryForecastTool = {
  name: 'get_inventory_forecast',
  description: 'Estimate available impressions for an ad unit over a future date range, based on historical delivery patterns. Useful for sales conversations and package planning.',
  inputSchema: {
    type: 'object' as const,
    required: ['adUnit', 'startDate', 'endDate'],
    properties: {
      adUnit: { type: 'string', description: 'Ad unit name' },
      startDate: { type: 'string', description: 'Forecast start date (YYYY-MM-DD)' },
      endDate: { type: 'string', description: 'Forecast end date (YYYY-MM-DD)' },
    },
  },
};

export async function handleGetInventoryForecast(client: DataClient, args: z.infer<typeof inventoryForecastSchema>) {
  const histEnd = new Date(); histEnd.setDate(histEnd.getDate() - 1);
  const histStart = new Date(histEnd); histStart.setDate(histStart.getDate() - 29);
  const fmt = (d: Date) => d.toISOString().split('T')[0];

  const historical = await client.getDeliveryReport({
    startDate: fmt(histStart),
    endDate: fmt(histEnd),
    dimensions: ['date', 'ad_unit'],
    filter: `WHERE AD_UNIT_NAME = '${args.adUnit}'`,
  });

  if (historical.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: `No historical data found for ad unit: ${args.adUnit}` }),
      }],
    };
  }

  const avgDailyRequests = historical.reduce((s, r) => s + r.totalRequests, 0) / historical.length;
  const avgFillRate = historical.reduce((s, r) => s + r.fillRate, 0) / historical.length;
  const avgEcpm = historical.reduce((s, r) => s + r.ecpm, 0) / historical.length;

  const forecastDays = Math.round(
    (new Date(args.endDate).getTime() - new Date(args.startDate).getTime()) / 86_400_000
  ) + 1;

  const projectedImpressions = Math.round(avgDailyRequests * avgFillRate * forecastDays);
  const projectedRevenue = (projectedImpressions / 1000) * avgEcpm;
  const availableImpressions = Math.round(avgDailyRequests * (1 - avgFillRate) * forecastDays);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        adUnit: args.adUnit,
        forecastPeriod: { start: args.startDate, end: args.endDate, days: forecastDays },
        projectedImpressions,
        availableImpressions,
        projectedRevenue: Math.round(projectedRevenue * 100) / 100,
        avgDailyRequests: Math.round(avgDailyRequests),
        avgFillRate: Math.round(avgFillRate * 1000) / 10,
        avgEcpm: Math.round(avgEcpm * 100) / 100,
        basedOnDays: historical.length,
        note: 'Projection based on 30-day historical average. Seasonal variation not accounted for.',
        fetchedAt: new Date().toISOString(),
      }, null, 2),
    }],
  };
}
