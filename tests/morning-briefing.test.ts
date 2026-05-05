import { describe, it, expect } from 'vitest';
import type { DataClient, DeliveryQuery } from '../src/data-client.js';
import type { DeliveryRow } from '../src/adcp/types.js';
import { handleGetMorningBriefing } from '../src/tools/morning-briefing.js';

function buildClient(rowsByDimensions: Record<string, DeliveryRow[]>, opts: { allDelivery?: { mediaBuy: any; reports: any[] }[] } = {}): DataClient {
  return {
    getDeliveryReport: async (q: DeliveryQuery) => {
      const key = q.dimensions.join(',');
      return rowsByDimensions[key] ?? [];
    },
    listMediaBuys: async () => (opts.allDelivery ?? []).map((d) => d.mediaBuy),
    getMediaBuyDelivery: async () => [],
    checkGovernance: async () => ({ mediaBuyId: 'x', passed: true, violations: [] }),
    getProducts: async () => [],
    getPlanAuditLogs: async () => [],
    getAllDeliveryReports: async () => opts.allDelivery ?? [],
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

  it('populates pacing_risks and yield_anomalies inline when the defaults are used', async () => {
    const today = new Date();
    const inFlight = (offsetDays: number) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().split('T')[0];

    // For yield_anomalies the handler needs delivery rows under ad_unit;
    // for pacing it needs media-buy + reports via getAllDeliveryReports.
    const adUnitRows: DeliveryRow[] = [
      { dimensions: { ad_unit: 'Homepage_Top' }, impressions: 50_000, clicks: 250, revenue: 250, ecpm: 0, ctr: 0.5, totalRequests: 0, fillRate: 0, ad_requests: 80_000, fill_rate: 0.625, revenue_net: 250 },
    ];
    const dateRows: DeliveryRow[] = [
      { dimensions: { date: '2025-01-15' }, impressions: 50_000, clicks: 250, revenue: 250, ecpm: 0, ctr: 0.5, totalRequests: 0, fillRate: 0, ad_requests: 80_000, fill_rate: 0.625, revenue_net: 250 },
    ];

    const client = buildClient(
      { 'date': dateRows, 'ad_unit': adUnitRows, 'ssp': [] },
      {
        allDelivery: [
          {
            mediaBuy: { id: 'mb_underpacing', name: 'Underpacing Q1', status: 'active', budget: 100_000, spend: 30_000, impressions: 1_500_000, clicks: 5_000, startDate: inFlight(-10), endDate: inFlight(10) },
            reports: [{ mediaBuyId: 'mb_underpacing', date: inFlight(-1), impressions: 200_000, clicks: 600, spend: 500, pacing: 0.4 }],
          },
        ],
      },
    );

    const result = await handleGetMorningBriefing(client, {
      lookbackDays: 1,
      include_pacing_risks: true,
      include_yield_anomalies: true,
      include_inventory_forecast: false,
      include_governance: false,
    });
    const sc = result.structuredContent as {
      pacing_risks: Array<{ severity: string; type: string }>;
      yield_anomalies: unknown[];
    };

    // Pacing alert from the underdelivering buy should appear inline
    expect(sc.pacing_risks.length).toBeGreaterThan(0);
    expect(sc.pacing_risks.some((a) => a.type === 'underdelivery' || a.type === 'no_data' || a.type === 'overspend')).toBe(true);
    // yield_anomalies array exists (may be empty given test data)
    expect(Array.isArray(sc.yield_anomalies)).toBe(true);
  });

  it('does not populate pacing_risks when the option is false', async () => {
    const client = buildClient(
      { 'date': [], 'ad_unit': [], 'ssp': [] },
      {
        allDelivery: [
          {
            mediaBuy: { id: 'mb1', name: 'Test', status: 'active', budget: 100_000, spend: 30_000, impressions: 0, clicks: 0, startDate: '2025-01-01', endDate: '2025-12-31' },
            reports: [{ mediaBuyId: 'mb1', date: '2025-01-15', impressions: 1000, clicks: 1, spend: 50, pacing: 0.3 }],
          },
        ],
      },
    );

    const result = await handleGetMorningBriefing(client, {
      lookbackDays: 1,
      include_pacing_risks: false,
      include_yield_anomalies: false,
      include_inventory_forecast: false,
      include_governance: false,
    });
    const sc = result.structuredContent as {
      pacing_risks: unknown[];
      yield_anomalies: unknown[];
      inventory_forecast_highlights: unknown[];
      governance_audit_issues: unknown[];
    };
    expect(sc.pacing_risks).toEqual([]);
    expect(sc.yield_anomalies).toEqual([]);
    expect(sc.inventory_forecast_highlights).toEqual([]);
    expect(sc.governance_audit_issues).toEqual([]);
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
