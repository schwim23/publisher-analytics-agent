import { describe, it, expect } from 'vitest';
import type { DataClient, DeliveryQuery, DeliveryFilter } from '../src/data-client.js';
import type { DeliveryRow } from '../src/adcp/types.js';
import { handleGetDeliverySummary } from '../src/tools/delivery-summary.js';

/**
 * Verifies that the typed `delivery_filter` field is propagated through
 * `DataClient.getDeliveryReport`, and that backends can honor it.
 */
function captureClient(rows: DeliveryRow[]): { client: DataClient; lastQuery: () => DeliveryQuery | null } {
  let lastQuery: DeliveryQuery | null = null;
  const client: DataClient = {
    getDeliveryReport: async (q) => {
      lastQuery = q;
      // Simulate a backend honoring the typed filter
      if (!q.delivery_filter) return rows;
      return rows.filter((r) => matchesRow(r, q.delivery_filter!));
    },
    listMediaBuys: async () => [],
    getMediaBuyDelivery: async () => [],
    checkGovernance: async () => ({ mediaBuyId: 'x', passed: true, violations: [] }),
    getProducts: async () => [],
    getPlanAuditLogs: async () => [],
    getAllDeliveryReports: async () => [],
  };
  return { client, lastQuery: () => lastQuery };
}

function matchesRow(r: DeliveryRow, f: DeliveryFilter): boolean {
  if (f.ad_unit && r.dimensions['ad_unit'] !== f.ad_unit) return false;
  if (f.demand_channel && r.dimensions['demand_channel'] !== f.demand_channel) return false;
  if (f.device && r.dimensions['device'] !== f.device) return false;
  if (f.geo && r.dimensions['country'] !== f.geo) return false;
  return true;
}

function row(opts: Partial<DeliveryRow> & { dimensions: Record<string, string> }): DeliveryRow {
  return {
    impressions: 100, clicks: 1, revenue: 5, ecpm: 0.5, ctr: 1, totalRequests: 200, fillRate: 0.5,
    ad_requests: 200, fill_rate: 0.5, revenue_net: 5,
    ...opts,
  };
}

describe('DeliveryFilter typed filter', () => {
  it('passes the typed delivery_filter through to the backend', async () => {
    const { client, lastQuery } = captureClient([
      row({ dimensions: { ad_unit: 'Homepage_Top' } }),
      row({ dimensions: { ad_unit: 'Footer_Banner' } }),
    ]);

    await handleGetDeliverySummary(client, {
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      dimensions: ['ad_unit'],
    });

    // The delivery-summary tool itself doesn't pass a filter, so confirm
    // delivery_filter is undefined (not crash) on the backend side
    expect(lastQuery()?.delivery_filter).toBeUndefined();
  });

  it('backend filters rows by ad_unit when delivery_filter.ad_unit is set', async () => {
    const { client } = captureClient([
      row({ dimensions: { ad_unit: 'Homepage_Top' }, impressions: 1000 }),
      row({ dimensions: { ad_unit: 'Footer_Banner' }, impressions: 500 }),
    ]);

    const filtered = await client.getDeliveryReport({
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      dimensions: ['ad_unit'],
      delivery_filter: { ad_unit: 'Homepage_Top' },
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].dimensions['ad_unit']).toBe('Homepage_Top');
  });

  it('backend filters rows by demand_channel when set', async () => {
    const { client } = captureClient([
      row({ dimensions: { demand_channel: 'pmp' }, impressions: 1000 }),
      row({ dimensions: { demand_channel: 'open_exchange' }, impressions: 500 }),
      row({ dimensions: { demand_channel: 'direct' }, impressions: 200 }),
    ]);

    const filtered = await client.getDeliveryReport({
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      dimensions: ['demand_channel'] as never[],
      delivery_filter: { demand_channel: 'pmp' },
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].dimensions['demand_channel']).toBe('pmp');
  });

  it('inventory-forecast tool sends typed delivery_filter alongside legacy PQL string', async () => {
    const { client, lastQuery } = captureClient([
      row({ dimensions: { ad_unit: 'Homepage_Top' }, impressions: 100_000, ad_requests: 150_000, fill_rate: 0.667, revenue_net: 100 }),
    ]);

    const { handleGetInventoryForecast } = await import('../src/tools/inventory-forecast.js');
    await handleGetInventoryForecast(client, {
      adUnit: 'Homepage_Top',
      startDate: '2025-02-01',
      endDate: '2025-02-07',
    });

    const q = lastQuery();
    expect(q?.delivery_filter?.ad_unit).toBe('Homepage_Top');
    // Legacy PQL string is also passed for backward compat with GAM backends
    expect(q?.filter).toMatch(/AD_UNIT_NAME = 'Homepage_Top'/);
  });
});
