import { describe, it, expect } from 'vitest';
import type { DataClient, DeliveryQuery } from '../src/data-client.js';
import type { DeliveryRow } from '../src/adcp/types.js';
import { handleGetYieldAnomalies } from '../src/tools/yield-anomalies.js';

function row(opts: Partial<DeliveryRow> & { dimensions: Record<string, string> }): DeliveryRow {
  return {
    impressions: 0, clicks: 0, revenue: 0, ecpm: 0, ctr: 0, totalRequests: 0, fillRate: 0,
    ...opts,
  };
}

function fakeClient(rowsByPeriod: Map<string, DeliveryRow[]>): DataClient {
  return {
    getDeliveryReport: async (q: DeliveryQuery) => rowsByPeriod.get(q.startDate) ?? [],
    listMediaBuys: async () => [],
    getMediaBuyDelivery: async () => [],
    checkGovernance: async () => ({ mediaBuyId: 'x', passed: true, violations: [] }),
    getProducts: async () => [],
    getPlanAuditLogs: async () => [],
    getAllDeliveryReports: async () => [],
  };
}

describe('yield anomalies', () => {
  it('detects an eCPM drop and emits a hypothesis with confidence + evidence', async () => {
    // 14-day window: baseline period (older 7) vs recent period (newer 7).
    // The handler computes period boundaries from "now"; we capture which
    // dates it queries by feeding the same rows for both periods and varying
    // by impressions+revenue magnitude.
    const baselineRows: DeliveryRow[] = [
      row({ dimensions: { ad_unit: 'Homepage_Top' }, impressions: 50_000, revenue: 500, ad_requests: 80_000, fill_rate: 0.625, revenue_net: 500 }),
    ];
    const recentRows: DeliveryRow[] = [
      row({ dimensions: { ad_unit: 'Homepage_Top' }, impressions: 50_000, revenue: 250, ad_requests: 80_000, fill_rate: 0.625, revenue_net: 250 }),
    ];

    // Trick: the tool queries baseline then recent. Both calls go through
    // getDeliveryReport with different startDate. We capture call order
    // and serve baseline first, recent second.
    let callCount = 0;
    const client: DataClient = {
      ...fakeClient(new Map()),
      getDeliveryReport: async () => {
        callCount += 1;
        return callCount === 1 ? recentRows : baselineRows;
      },
    };

    const result = await handleGetYieldAnomalies(client, {
      lookbackDays: 14,
      dimensions: ['ad_unit'],
      minImpressions: 1000,
    });
    const sc = result.structuredContent as { anomalies: Array<{ metric: string; change_percent: number; hypotheses: Array<{ label: string; confidence: string; evidence: string[] }> }> };
    const ecpmAnomaly = sc.anomalies.find((a) => a.metric === 'ecpm');
    expect(ecpmAnomaly).toBeDefined();
    expect(ecpmAnomaly!.change_percent).toBeLessThan(-30); // 50% eCPM drop
    expect(ecpmAnomaly!.hypotheses.length).toBeGreaterThan(0);
    expect(ecpmAnomaly!.hypotheses[0].confidence).toBeDefined();
    expect(ecpmAnomaly!.hypotheses[0].evidence.length).toBeGreaterThan(0);
  });

  it('detects a fill-rate drop with floor-price increase as a compound hypothesis', async () => {
    const baselineRows: DeliveryRow[] = [
      row({ dimensions: { ad_unit: 'Article_Inline' }, impressions: 50_000, revenue: 250, ad_requests: 60_000, fill_rate: 50_000 / 60_000, floor_price: 1.0, revenue_net: 250 }),
    ];
    const recentRows: DeliveryRow[] = [
      row({ dimensions: { ad_unit: 'Article_Inline' }, impressions: 30_000, revenue: 150, ad_requests: 60_000, fill_rate: 30_000 / 60_000, floor_price: 1.5, revenue_net: 150 }),
    ];

    let callCount = 0;
    const client: DataClient = {
      ...fakeClient(new Map()),
      getDeliveryReport: async () => {
        callCount += 1;
        return callCount === 1 ? recentRows : baselineRows;
      },
    };

    const result = await handleGetYieldAnomalies(client, {
      lookbackDays: 14,
      dimensions: ['ad_unit'],
      minImpressions: 1000,
    });
    const sc = result.structuredContent as { anomalies: Array<{ metric: string; hypotheses: Array<{ label: string }> }> };
    const fillRateAnomalies = sc.anomalies.filter((a) => a.metric === 'fill_rate');
    expect(fillRateAnomalies.length).toBeGreaterThan(0);
    // Across all fill_rate hypotheses on this dimension, at least one should
    // surface the floor-price or demand-side angle (compound check).
    const allLabels = fillRateAnomalies.flatMap((a) => a.hypotheses.map((h) => h.label.toLowerCase())).join(' ');
    expect(allLabels).toMatch(/floor|demand/);
  });

  it('returns zero anomalies when periods are equivalent', async () => {
    const sameRow = row({ dimensions: { ad_unit: 'Homepage_Top' }, impressions: 50_000, revenue: 500, ad_requests: 80_000, fill_rate: 0.625, revenue_net: 500 });
    const client: DataClient = {
      ...fakeClient(new Map()),
      getDeliveryReport: async () => [sameRow],
    };
    const result = await handleGetYieldAnomalies(client, { lookbackDays: 14, dimensions: ['ad_unit'], minImpressions: 1000 });
    const sc = result.structuredContent as { total: number };
    expect(sc.total).toBe(0);
  });
});
