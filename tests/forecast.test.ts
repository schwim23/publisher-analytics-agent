import { describe, it, expect } from 'vitest';
import type { DataClient } from '../src/data-client.js';
import type { DeliveryRow } from '../src/adcp/types.js';
import { handleGetInventoryForecast } from '../src/tools/inventory-forecast.js';

function row(opts: Partial<DeliveryRow> & { dimensions: Record<string, string> }): DeliveryRow {
  // Default legacy `revenue` to NaN so the row's revenue is genuinely absent
  // unless the test sets `revenue_net` / `revenue_gross` / etc. (Setting it
  // to 0 would be a valid finite sample for the revenue-CI calculation.)
  return {
    impressions: 0, clicks: 0, revenue: Number.NaN, ecpm: 0, ctr: 0, totalRequests: 0, fillRate: 0,
    ...opts,
  };
}

function buildClient(history: DeliveryRow[]): DataClient {
  return {
    getDeliveryReport: async () => history,
    listMediaBuys: async () => [],
    getMediaBuyDelivery: async () => [],
    checkGovernance: async () => ({ mediaBuyId: 'x', passed: true, violations: [] }),
    getProducts: async () => [],
    getPlanAuditLogs: async () => [],
    getAllDeliveryReports: async () => [],
  };
}

describe('inventory forecast', () => {
  it('returns separate impressions and revenue confidence intervals when both have enough samples', async () => {
    const history: DeliveryRow[] = Array.from({ length: 14 }, (_, i) => row({
      dimensions: { date: `2025-01-${String(i + 1).padStart(2, '0')}`, ad_unit: 'Homepage_Top' },
      impressions: 100_000 + (i * 1500), // mild upward variance
      ad_requests: 150_000,
      fill_rate: 0.667,
      revenue_net: 50 + i * 0.8, // independent variance from impressions
    }));

    const result = await handleGetInventoryForecast(buildClient(history), {
      adUnit: 'Homepage_Top',
      startDate: '2025-02-01',
      endDate: '2025-02-07',
    });

    const sc = result.structuredContent as {
      impressions_confidence_interval?: { level: number; low: number | null; high: number | null };
      revenue_confidence_interval?: { level: number; low: number | null; high: number | null };
      basis: string;
    };

    expect(sc.impressions_confidence_interval).toBeDefined();
    expect(sc.impressions_confidence_interval!.level).toBe(0.8);
    expect(sc.impressions_confidence_interval!.low).toBeLessThan(sc.impressions_confidence_interval!.high!);

    expect(sc.revenue_confidence_interval).toBeDefined();
    expect(sc.revenue_confidence_interval!.level).toBe(0.8);
    expect(sc.revenue_confidence_interval!.low).toBeLessThan(sc.revenue_confidence_interval!.high!);

    // The two intervals are independent — they're not just rescaled versions
    // of each other (revenue CI is computed from revenue samples, not from
    // impressions CI × eCPM).
    expect(sc.basis).toBe('historical_delivery');
  });

  it('omits revenue_confidence_interval when there are fewer than 3 revenue samples', async () => {
    const history: DeliveryRow[] = Array.from({ length: 14 }, (_, i) => row({
      dimensions: { date: `2025-01-${String(i + 1).padStart(2, '0')}`, ad_unit: 'Homepage_Top' },
      impressions: 100_000 + i * 1000,
      ad_requests: 150_000,
      fill_rate: 0.667,
      // no revenue_net — revenue per-day samples will be empty after filtering
    }));

    const result = await handleGetInventoryForecast(buildClient(history), {
      adUnit: 'Homepage_Top',
      startDate: '2025-02-01',
      endDate: '2025-02-07',
    });

    const sc = result.structuredContent as {
      impressions_confidence_interval?: unknown;
      revenue_confidence_interval?: unknown;
    };

    expect(sc.impressions_confidence_interval).toBeDefined();
    expect(sc.revenue_confidence_interval).toBeUndefined();
  });

  it('labels basis as true_availability_unknown when ad_requests are missing', async () => {
    const history: DeliveryRow[] = Array.from({ length: 14 }, (_, i) => row({
      dimensions: { date: `2025-01-${String(i + 1).padStart(2, '0')}`, ad_unit: 'Homepage_Top' },
      impressions: 100_000 + i * 1000,
      // no ad_requests, no fill_rate
      revenue_net: 50,
    }));

    const result = await handleGetInventoryForecast(buildClient(history), {
      adUnit: 'Homepage_Top',
      startDate: '2025-02-01',
      endDate: '2025-02-07',
    });

    const sc = result.structuredContent as { basis: string; warnings: Array<{ code: string }> };
    expect(sc.basis).toBe('true_availability_unknown');
    expect(sc.warnings.some((w) => w.code === 'TOTAL_REQUESTS_UNAVAILABLE' || w.code === 'FILL_RATE_UNAVAILABLE')).toBe(true);
  });
});
