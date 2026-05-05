import { describe, it, expect } from 'vitest';
import type { DataClient, DeliveryQuery } from '../src/data-client.js';
import type { DeliveryRow } from '../src/adcp/types.js';
import { handleGetMorningBriefing } from '../src/tools/morning-briefing.js';

function buildClient(rowsByDimensions: Record<string, DeliveryRow[]>): DataClient {
  return {
    getDeliveryReport: async (q: DeliveryQuery) => {
      const key = q.dimensions.join(',');
      return rowsByDimensions[key] ?? [];
    },
    listMediaBuys: async () => [],
    getMediaBuyDelivery: async () => [],
    checkGovernance: async () => ({ mediaBuyId: 'x', passed: true, violations: [] }),
    getProducts: async () => [],
    getPlanAuditLogs: async () => [],
    getAllDeliveryReports: async () => [],
  };
}

describe('morning briefing composition', () => {
  it('composes all expected sections in the structured response', async () => {
    const client = buildClient({
      'date': [{
        dimensions: { date: '2025-01-15' },
        impressions: 1_000_000, clicks: 5_000, revenue: 500, ecpm: 0.5, ctr: 0.5, totalRequests: 1_500_000, fillRate: 0.667,
        revenue_net: 500, revenue_gross: 700, ecpm_net: 0.5, ecpm_gross: 0.7, fill_rate: 0.667, ad_requests: 1_500_000,
      }],
      'ad_unit': [
        {
          dimensions: { ad_unit: 'Homepage_Top' },
          impressions: 600_000, clicks: 3_000, revenue: 300, ecpm: 0.5, ctr: 0.5, totalRequests: 900_000, fillRate: 0.667,
          revenue_net: 300, fill_rate: 0.667, ad_requests: 900_000,
        },
      ],
      'ssp': [
        {
          dimensions: { ssp: 'google_adx' },
          impressions: 700_000, clicks: 3_500, revenue: 350, ecpm: 0.5, ctr: 0.5, totalRequests: 1_000_000, fillRate: 0.7,
          revenue_net: 350, fill_rate: 0.7,
        },
      ],
    });

    const result = await handleGetMorningBriefing(client, { lookbackDays: 1 });
    const sc = result.structuredContent as {
      executive_summary: string;
      revenue_and_delivery: {
        impressions: number;
        revenue_net: number;
        ecpm_net: number;
        fill_rate: number;
        top_ad_units: Array<{ name: string }>;
        ssp_breakdown: Array<{ name: string }>;
      };
      pacing_risks: unknown[];
      yield_anomalies: unknown[];
      data_quality_caveats: unknown[];
      recommended_actions: string[];
    };

    expect(sc.executive_summary).toBeTruthy();
    expect(sc.revenue_and_delivery.impressions).toBe(1_000_000);
    expect(sc.revenue_and_delivery.revenue_net).toBe(500);
    expect(sc.revenue_and_delivery.fill_rate).toBeCloseTo(0.667, 2);
    expect(sc.revenue_and_delivery.top_ad_units[0].name).toBe('Homepage_Top');
    expect(sc.revenue_and_delivery.ssp_breakdown[0].name).toBe('google_adx');
    expect(Array.isArray(sc.pacing_risks)).toBe(true);
    expect(Array.isArray(sc.yield_anomalies)).toBe(true);
    expect(Array.isArray(sc.data_quality_caveats)).toBe(true);
    expect(Array.isArray(sc.recommended_actions)).toBe(true);
  });

  it('surfaces low-fill caveat when fill_rate is null', async () => {
    const client = buildClient({
      'date': [{
        dimensions: { date: '2025-01-15' },
        impressions: 1000, clicks: 5, revenue: 1, ecpm: 0, ctr: 0.5, totalRequests: 0, fillRate: 0,
        // No fill_rate, no ad_requests → null fill rate aggregate
      }],
      'ad_unit': [],
      'ssp': [],
    });

    const result = await handleGetMorningBriefing(client, { lookbackDays: 1 });
    const sc = result.structuredContent as {
      revenue_and_delivery: { fill_rate: number | null };
      data_quality_caveats: Array<{ code: string }>;
    };
    expect(sc.revenue_and_delivery.fill_rate).toBeNull();
    expect(sc.data_quality_caveats.some((c) => c.code === 'FILL_RATE_UNAVAILABLE')).toBe(true);
  });
});
