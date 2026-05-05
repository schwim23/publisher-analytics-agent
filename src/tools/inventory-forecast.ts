import type { DataClient } from '../data-client.js';
import {
  inventoryForecastRequestSchema,
  inventoryForecastResponseSchema,
  type InventoryForecastRequest,
  type DataQualityWarning,
  type ConfidenceLevel,
} from '../extension/schemas.js';
import { rowFillRate, rowAdRequests, rowRevenue, computeEcpm } from '../extension/metric-helpers.js';
import { structured, fmtNum, fmtMoney } from '../extension/tool-result.js';

export const inventoryForecastSchema = inventoryForecastRequestSchema;

export const inventoryForecastTool = {
  name: 'get_inventory_forecast',
  description: 'Estimate impressions for an ad unit over a future date range, projected from 30 days of historical delivery. Returns confidence interval and clearly labels the basis (historical_delivery vs true_availability_unknown). NOT a guaranteed availability forecast — for that you need an ad-server forecasting API.',
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

export async function handleGetInventoryForecast(client: DataClient, args: InventoryForecastRequest) {
  const histEnd = new Date(); histEnd.setUTCDate(histEnd.getUTCDate() - 1);
  const histStart = new Date(histEnd); histStart.setUTCDate(histStart.getUTCDate() - 29);
  const fmt = (d: Date) => d.toISOString().split('T')[0];

  // Use the typed `delivery_filter` (preferred) — backends translate to their
  // native filter language. Pass the legacy PQL string too for GAM-style
  // backends that haven't migrated yet (they'll match either or both).
  const historical = await client.getDeliveryReport({
    startDate: fmt(histStart),
    endDate: fmt(histEnd),
    dimensions: ['date', 'ad_unit'],
    delivery_filter: { ad_unit: args.adUnit },
    filter: `WHERE AD_UNIT_NAME = '${args.adUnit.replace(/'/g, "\\'")}'`,
  });

  const caveats: string[] = [];
  const warnings: DataQualityWarning[] = [];

  if (historical.length === 0) {
    return structured({
      schema: inventoryForecastResponseSchema,
      data: {
        ad_unit: args.adUnit,
        forecast_period: { start: args.startDate, end: args.endDate, days: 1 },
        basis: 'true_availability_unknown',
        projected_impressions: null,
        available_impressions: null,
        projected_revenue: null,
        confidence: 'low',
        inputs: { history_days: 0, avg_daily_requests: null, avg_fill_rate: null, avg_ecpm: null },
        caveats: ['No historical data found for this ad unit.'],
        warnings: [{ code: 'INSUFFICIENT_HISTORY', message: 'No historical delivery for this ad unit; cannot forecast.', severity: 'critical' }],
        generated_at: new Date().toISOString(),
      },
      text: () => `No historical data for ad unit "${args.adUnit}". Forecast unavailable.`,
    });
  }

  const requestSamples = historical.map((r) => rowAdRequests(r)).filter((v): v is number => v !== null);
  const fillSamples = historical.map((r) => rowFillRate(r)).filter((v): v is number => v !== null);
  const revenueSamples = historical.map((r) => {
    const rev = rowRevenue(r);
    return rev.value;
  }).filter((v): v is number => v !== null);

  const avgDailyRequests = avg(requestSamples);
  const avgFillRate = avg(fillSamples);
  const avgEcpm = (() => {
    if (revenueSamples.length === 0) return null;
    const totalRev = sum(revenueSamples);
    const totalImps = sum(historical.map((r) => r.impressions ?? 0));
    return computeEcpm(totalRev, totalImps);
  })();

  if (avgDailyRequests === null) {
    warnings.push({ code: 'TOTAL_REQUESTS_UNAVAILABLE', message: 'No ad-request volume in history; using impressions as a request proxy reduces accuracy.', severity: 'warning' });
    caveats.push('Ad-request data unavailable; projection is based on impression history alone.');
  }
  if (avgFillRate === null) {
    warnings.push({ code: 'FILL_RATE_UNAVAILABLE', message: 'No fill-rate in history; available_impressions cannot be computed reliably.', severity: 'warning' });
  }
  if (avgEcpm === null) {
    caveats.push('No revenue history; projected_revenue is null.');
  }

  const forecastDays = Math.max(1, Math.round(
    (new Date(args.endDate).getTime() - new Date(args.startDate).getTime()) / 86_400_000,
  ) + 1);

  // Compute projected impressions: prefer request × fill, fall back to direct impression history
  let projectedImpressions: number | null;
  if (avgDailyRequests !== null && avgFillRate !== null) {
    projectedImpressions = Math.round(avgDailyRequests * avgFillRate * forecastDays);
  } else {
    const avgImpsPerDay = avg(historical.map((r) => r.impressions ?? null).filter((v): v is number => v !== null));
    projectedImpressions = avgImpsPerDay !== null ? Math.round(avgImpsPerDay * forecastDays) : null;
    if (projectedImpressions !== null) {
      caveats.push('projected_impressions derived from impression history (no request data); precision is reduced.');
    }
  }

  const availableImpressions = (avgDailyRequests !== null && avgFillRate !== null)
    ? Math.round(avgDailyRequests * (1 - avgFillRate) * forecastDays)
    : null;

  const projectedRevenue = projectedImpressions !== null && avgEcpm !== null
    ? Math.round((projectedImpressions / 1000) * avgEcpm * 100) / 100
    : null;

  // Two independent CIs — impressions and revenue — derived from per-day
  // sample variance over the history window. Revenue CI is computed directly
  // from per-day revenue samples, not by combining impression CI with eCPM
  // (which would understate variance).
  const impressionsCI = confidenceInterval(
    historical.map((r) => r.impressions ?? null).filter((v): v is number => v !== null),
    forecastDays,
    0.8,
  );
  const revenuePerDay = historical.map((r) => {
    const v = rowRevenue(r).value;
    return v !== null && Number.isFinite(v) ? v : null;
  }).filter((v): v is number => v !== null);
  const revenueCI = confidenceInterval(revenuePerDay, forecastDays, 0.8);

  let confidence: ConfidenceLevel = 'medium';
  if (historical.length < 7) { confidence = 'low'; caveats.push(`Only ${historical.length} days of history available — confidence is low.`); }
  else if (historical.length < 14) confidence = 'low';
  else if (avgDailyRequests === null || avgFillRate === null) confidence = 'low';

  const basis = avgDailyRequests !== null ? 'historical_delivery' : 'true_availability_unknown';

  caveats.push('Projection assumes traffic + fill stay flat; seasonal variation is not modeled.');
  caveats.push('NOT a guaranteed availability forecast — for that, query your ad server\'s native forecasting API.');

  return structured({
    schema: inventoryForecastResponseSchema,
    data: {
      ad_unit: args.adUnit,
      forecast_period: { start: args.startDate, end: args.endDate, days: forecastDays },
      basis,
      projected_impressions: projectedImpressions,
      available_impressions: availableImpressions,
      projected_revenue: projectedRevenue,
      confidence,
      impressions_confidence_interval: impressionsCI,
      revenue_confidence_interval: revenueCI,
      inputs: {
        history_days: historical.length,
        avg_daily_requests: avgDailyRequests,
        avg_fill_rate: avgFillRate,
        avg_ecpm: avgEcpm,
      },
      caveats,
      warnings,
      generated_at: new Date().toISOString(),
    },
    text: (parsed) => [
      `Forecast for ${parsed.ad_unit} (${parsed.forecast_period.days} days; basis=${parsed.basis}; confidence=${parsed.confidence})`,
      `  Projected impressions: ${fmtNum(parsed.projected_impressions)}${parsed.impressions_confidence_interval ? ` (80% CI ${fmtNum(parsed.impressions_confidence_interval.low)}–${fmtNum(parsed.impressions_confidence_interval.high)})` : ''}`,
      `  Available impressions: ${fmtNum(parsed.available_impressions)}`,
      `  Projected revenue: ${fmtMoney(parsed.projected_revenue)}${parsed.revenue_confidence_interval ? ` (80% CI ${fmtMoney(parsed.revenue_confidence_interval.low)}–${fmtMoney(parsed.revenue_confidence_interval.high)})` : ''}`,
      (parsed.caveats ?? []).length ? `  Caveats: ${(parsed.caveats ?? [])[0]}${(parsed.caveats ?? []).length > 1 ? ` (+${(parsed.caveats ?? []).length - 1} more)` : ''}` : '',
    ].filter(Boolean).join('\n'),
  });
}

function avg(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function sum(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0);
}

/**
 * Compute a confidence interval for a forecast value derived from per-day
 * samples. Returns undefined when there aren't enough samples (< 3 days) for
 * variance to be meaningful.
 *
 * Approach: standard normal approximation on the per-day mean × forecastDays.
 * `level` is the two-sided coverage probability (e.g. 0.8 for 80%); the
 * z-multiplier is set from common values.
 */
function confidenceInterval(perDay: number[], forecastDays: number, level: number): { level: number; low: number | null; high: number | null } | undefined {
  if (perDay.length < 3) return undefined;
  const mean = avg(perDay)!;
  const variance = perDay.reduce((acc, v) => acc + (v - mean) ** 2, 0) / perDay.length;
  const sd = Math.sqrt(variance);
  const z = zForLevel(level);
  const dailyLow = Math.max(0, mean - z * sd);
  const dailyHigh = mean + z * sd;
  return {
    level,
    low: Math.round(dailyLow * forecastDays * 100) / 100,
    high: Math.round(dailyHigh * forecastDays * 100) / 100,
  };
}

function zForLevel(level: number): number {
  // Two-sided z-multipliers for common levels. Falls back to 1.28 (80%).
  if (level >= 0.99) return 2.58;
  if (level >= 0.95) return 1.96;
  if (level >= 0.9) return 1.645;
  if (level >= 0.8) return 1.282;
  return 1.282;
}
