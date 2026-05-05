import { describe, it, expect } from 'vitest';
import type { DataClient } from '../src/data-client.js';
import type { DealMetricRow } from '../src/extension/schemas.js';
import {
  dealDiagnosticsRequestSchema,
  dealDiagnosticsResponseSchema,
  dealMetricRowSchema,
  dealFunnelSchema,
} from '../src/extension/schemas.js';
import { handleGetDealDiagnostics } from '../src/tools/deal-diagnostics.js';
import { handleGetAdcpCapabilities } from '../src/adcp/capabilities.js';
import { tools } from '../src/tools/index.js';

function deal(overrides: Partial<DealMetricRow> & { deal_id: string }): DealMetricRow {
  return {
    deal_id: overrides.deal_id,
    deal_type: 'programmatic_guaranteed',
    warnings: [],
    breakdowns: [],
    ...overrides,
  };
}

function buildClient(rows: DealMetricRow[], opts: { withDealMethod?: boolean } = { withDealMethod: true }): DataClient {
  const base: DataClient = {
    getDeliveryReport: async () => [],
    listMediaBuys: async () => [],
    getMediaBuyDelivery: async () => [],
    checkGovernance: async () => ({ mediaBuyId: 'x', passed: true, violations: [] }),
    getProducts: async () => [],
    getPlanAuditLogs: async () => [],
    getAllDeliveryReports: async () => [],
  };
  if (opts.withDealMethod !== false) {
    base.getDealDiagnosticsData = async () => rows;
  }
  return base;
}

const HEALTHY: DealMetricRow = {
  deal_id: 'healthy_01',
  deal_name: 'Healthy PG',
  deal_type: 'programmatic_guaranteed',
  buyer: 'Acme',
  ssp: 'magnite',
  booked_impressions: 700_000,
  start_date: dateOffset(-10),
  end_date: dateOffset(20),
  eligible_ad_requests: 1_000_000,
  deal_bid_requests: 950_000,
  bid_responses: 720_000,
  valid_bids: 715_000,
  bids_above_floor: 700_000,
  auction_wins: 250_000,
  impressions: 250_000,
  buyer_spend: 2_500,
  revenue_net: 2_400,
  floor_price: 8,
  avg_bid_cpm: 12,
  creative_status: 'approved',
  warnings: [],
  breakdowns: [],
};

function dateOffset(days: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

describe('deal diagnostics — schema validation', () => {
  it('request schema: defaults min_severity to info and include_breakdown to false', () => {
    const parsed = dealDiagnosticsRequestSchema.parse({});
    expect(parsed.min_severity).toBe('info');
    expect(parsed.include_breakdown).toBe(false);
  });

  it('request schema: rejects malformed dates in date_range', () => {
    expect(() => dealDiagnosticsRequestSchema.parse({
      date_range: { start: '2025/01/01', end: '2025-01-31' },
    })).toThrow();
  });

  it('row schema: requires deal_id and validates rate fields are within [0,1]', () => {
    expect(() => dealMetricRowSchema.parse({})).toThrow();
    expect(() => dealMetricRowSchema.parse({ deal_id: 'd1', bid_rate: 1.5 })).toThrow();
    const ok = dealMetricRowSchema.parse({ deal_id: 'd1' });
    expect(ok.deal_type).toBe('unknown');
    expect(ok.warnings).toEqual([]);
  });

  it('funnel schema: each rate must be in [0,1] or null', () => {
    expect(() => dealFunnelSchema.parse({
      eligible_ad_requests: 1, deal_bid_requests: 1, bid_responses: 1,
      valid_bids: 1, bids_above_floor: 1, auction_wins: 1, impressions: 1,
      request_to_response_rate: 1.5, response_to_above_floor_rate: null,
      above_floor_to_win_rate: null, win_to_impression_rate: null,
    })).toThrow();
  });
});

describe('deal diagnostics — rule-based scenarios', () => {
  it('healthy deal emits no high-severity diagnostics', async () => {
    const result = await handleGetDealDiagnostics(buildClient([HEALTHY]), {
      include_breakdown: false,
      min_severity: 'info',
    });
    const sc = result.structuredContent as {
      deals: Array<{ deal_id: string; health_status: string; issues: Array<{ severity: string }> }>;
    };
    expect(sc.deals[0].health_status).toBe('healthy');
    const seriousIssues = sc.deals[0].issues.filter((i) => i.severity === 'critical' || i.severity === 'warning');
    expect(seriousIssues).toEqual([]);
  });

  it('low bid response rate creates LOW_BID_RATE issue', async () => {
    const lowBid = deal({
      ...HEALTHY,
      deal_id: 'low_bid_01',
      bid_responses: 60_000, // 60k / 950k ≈ 6.3%
    });
    const result = await handleGetDealDiagnostics(buildClient([lowBid]), { include_breakdown: false, min_severity: 'info' });
    const sc = result.structuredContent as {
      deals: Array<{ health_status: string; issues: Array<{ code: string; severity: string }> }>;
    };
    const codes = sc.deals[0].issues.map((i) => i.code);
    expect(codes).toContain('LOW_BID_RATE');
    expect(['critical', 'at_risk']).toContain(sc.deals[0].health_status);
  });

  it('floor above avg bid creates FLOOR_MISMATCH', async () => {
    const floorMismatch = deal({
      ...HEALTHY,
      deal_id: 'floor_01',
      floor_price: 15,
      avg_bid_cpm: 6,
      bids_above_floor: 20_000, // makes response_to_above_floor very low
      auction_wins: 8_000,
      impressions: 8_000,
    });
    const result = await handleGetDealDiagnostics(buildClient([floorMismatch]), { include_breakdown: false, min_severity: 'info' });
    const sc = result.structuredContent as { deals: Array<{ issues: Array<{ code: string }> }> };
    expect(sc.deals[0].issues.map((i) => i.code)).toContain('FLOOR_MISMATCH');
  });

  it('low eligible supply creates SUPPLY_CONSTRAINT', async () => {
    const supplyStarved = deal({
      ...HEALTHY,
      deal_id: 'supply_01',
      eligible_ad_requests: 0,
      deal_bid_requests: 0,
      bid_responses: 0,
      bids_above_floor: 0,
      auction_wins: 0,
      impressions: 0,
    });
    const result = await handleGetDealDiagnostics(buildClient([supplyStarved]), { include_breakdown: false, min_severity: 'info' });
    const sc = result.structuredContent as { deals: Array<{ health_status: string; issues: Array<{ code: string; severity: string }> }> };
    const constraint = sc.deals[0].issues.find((i) => i.code === 'SUPPLY_CONSTRAINT');
    expect(constraint).toBeDefined();
    expect(constraint!.severity).toBe('critical');
    expect(sc.deals[0].health_status).toBe('critical');
  });

  it('creative rejected creates CREATIVE_BLOCKED critical', async () => {
    const blocked = deal({
      ...HEALTHY,
      deal_id: 'creative_01',
      creative_status: 'rejected',
      auction_wins: 0,
      impressions: 0,
    });
    const result = await handleGetDealDiagnostics(buildClient([blocked]), { include_breakdown: false, min_severity: 'info' });
    const sc = result.structuredContent as { deals: Array<{ health_status: string; issues: Array<{ code: string; severity: string }> }> };
    const issue = sc.deals[0].issues.find((i) => i.code === 'CREATIVE_BLOCKED');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('critical');
    expect(sc.deals[0].health_status).toBe('critical');
  });

  it('underpacing creates UNDERPACING with confidence based on basis', async () => {
    const underPacing = deal({
      ...HEALTHY,
      deal_id: 'pacing_01',
      // 10 days into a 30-day flight (~33% elapsed) but only 5% of booked impressions
      booked_impressions: 1_000_000,
      impressions: 50_000,
      start_date: dateOffset(-10),
      end_date: dateOffset(20),
    });
    const result = await handleGetDealDiagnostics(buildClient([underPacing]), { include_breakdown: false, min_severity: 'info' });
    const sc = result.structuredContent as {
      deals: Array<{ pacing: { basis: string; confidence: string } | null; issues: Array<{ code: string; severity: string }> }>;
    };
    const issue = sc.deals[0].issues.find((i) => i.code === 'UNDERPACING');
    expect(issue).toBeDefined();
    expect(['critical', 'warning']).toContain(issue!.severity);
    expect(sc.deals[0].pacing?.basis).toBe('booked_impressions');
    expect(sc.deals[0].pacing?.confidence).toBe('high');
  });

  it('missing funnel data emits DATA_INSUFFICIENT, not fake metrics', async () => {
    const missing = deal({
      deal_id: 'missing_01',
      deal_name: 'No funnel data',
      deal_type: 'preferred_deal',
      buyer: 'Foo',
      // No eligible_ad_requests, no bid_requests, no responses
      impressions: 100, // some downstream data exists
    });
    const result = await handleGetDealDiagnostics(buildClient([missing]), { include_breakdown: false, min_severity: 'info' });
    const sc = result.structuredContent as {
      deals: Array<{
        funnel: { eligible_ad_requests: number | null; bid_responses: number | null; request_to_response_rate: number | null };
        issues: Array<{ code: string }>;
      }>;
    };
    expect(sc.deals[0].funnel.eligible_ad_requests).toBeNull();
    expect(sc.deals[0].funnel.bid_responses).toBeNull();
    expect(sc.deals[0].funnel.request_to_response_rate).toBeNull();
    expect(sc.deals[0].issues.map((i) => i.code)).toContain('DATA_INSUFFICIENT');
  });

  it('response validates against the response schema', async () => {
    const result = await handleGetDealDiagnostics(buildClient([HEALTHY]), { include_breakdown: false, min_severity: 'info' });
    // structured() already parses on the way out, but re-parse to confirm
    expect(() => dealDiagnosticsResponseSchema.parse(result.structuredContent)).not.toThrow();
  });

  it('emits BACKEND_FALLBACK when the backend has no getDealDiagnosticsData', async () => {
    const result = await handleGetDealDiagnostics(buildClient([], { withDealMethod: false }), { include_breakdown: false, min_severity: 'info' });
    const sc = result.structuredContent as { deals: unknown[]; warnings: Array<{ code: string }> };
    expect(sc.deals).toEqual([]);
    expect(sc.warnings.some((w) => w.code === 'BACKEND_FALLBACK')).toBe(true);
  });
});

describe('deal diagnostics — capability advertisement', () => {
  it('get_adcp_capabilities lists get_deal_diagnostics under the x-publisher-analytics extension only', () => {
    const result = handleGetAdcpCapabilities({
      agentId: 'pa-test',
      agentName: 'Test',
      agentVersion: '0.1.0',
      toolNames: tools.map((t) => t.name),
      transports: ['stdio'],
    });
    const sc = result.structuredContent as {
      supported_protocols: string[];
      specialisms: string[];
      extensions: { 'x-publisher-analytics': { tools: string[]; client_utilities: string[] } };
    };
    expect(sc.supported_protocols).toEqual([]);
    expect(sc.specialisms).toEqual([]);
    expect(sc.extensions['x-publisher-analytics'].tools).toContain('get_deal_diagnostics');
    expect(sc.extensions['x-publisher-analytics'].client_utilities).not.toContain('get_deal_diagnostics');
  });
});
