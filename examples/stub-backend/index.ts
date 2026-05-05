/**
 * Minimal in-memory DataClient implementation. Generates deterministic synthetic delivery
 * data so the agent can be exercised without any real ad-server credentials.
 *
 * Run as stdio (default):  node dist/examples/stub-backend/index.js
 * Run as HTTP:              ADAM_TRANSPORT=http BEARER=secret node dist/examples/stub-backend/index.js
 */

import type {
  DataClient,
  DeliveryQuery,
  DeliveryRow,
  MediaBuy,
  DeliveryReport,
  GovernanceResult,
  InventoryProduct,
  AuditLogEntry,
  DealMetricRow,
} from '../../src/index.js';
import { createPublisherAnalyticsServer } from '../../src/index.js';

const AD_UNITS = ['Homepage_Top', 'Homepage_Sidebar', 'Article_Inline', 'Footer_Banner'];
const SSPS = ['google_adx', 'pubmatic', 'magnite', 'index'];

function* eachDate(start: string, end: string): Generator<string> {
  const cur = new Date(start);
  const stop = new Date(end);
  while (cur <= stop) {
    yield cur.toISOString().split('T')[0];
    cur.setDate(cur.getDate() + 1);
  }
}

function pseudo(seed: string): number {
  // FNV-1a 32-bit, with `| 0` to keep h in signed 32-bit range each step.
  let h = 2166136261 | 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h ^ seed.charCodeAt(i)) | 0;
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

const stubClient: DataClient = {
  async getDeliveryReport(query: DeliveryQuery): Promise<DeliveryRow[]> {
    const rows: DeliveryRow[] = [];
    const dimSets: Record<string, string[]> = {
      date: [...eachDate(query.startDate, query.endDate)],
      ad_unit: AD_UNITS,
      ssp: SSPS,
      device: ['desktop', 'mobile', 'tablet'],
      country: ['US', 'GB', 'CA'],
      order: ['Q1_Branding', 'Always_On'],
      line_item: ['Display_Standard', 'Video_Premium'],
    };
    function combinations(dims: string[]): Record<string, string>[] {
      if (dims.length === 0) return [{}];
      const [head, ...rest] = dims;
      const tails = combinations(rest);
      return (dimSets[head] ?? ['']).flatMap((v) => tails.map((t) => ({ ...t, [head]: v })));
    }

    // Honor the typed filter — silently drop combos that don't match.
    const f = query.delivery_filter;
    function matchesFilter(combo: Record<string, string>): boolean {
      if (!f) return true;
      if (f.ad_unit && combo['ad_unit'] && combo['ad_unit'] !== f.ad_unit) return false;
      if (f.ssp && combo['ssp'] && combo['ssp'] !== f.ssp) return false;
      if (f.device && combo['device'] && combo['device'] !== f.device) return false;
      if (f.geo && combo['country'] && combo['country'] !== f.geo) return false;
      if (f.format && combo['format'] && combo['format'] !== f.format) return false;
      if (f.demand_channel && combo['demand_channel'] && combo['demand_channel'] !== f.demand_channel) return false;
      return true;
    }

    const fetchedAt = new Date().toISOString();
    for (const combo of combinations(query.dimensions)) {
      if (!matchesFilter(combo)) continue;
      const seed = JSON.stringify(combo);
      const impressions = Math.floor(pseudo(seed) * 50_000) + 1_000;
      const ctr = 0.005 + pseudo(seed + 'ctr') * 0.02;
      const ecpmGross = 1 + pseudo(seed + 'ecpm') * 8;
      const revShare = 0.7 + pseudo(seed + 'rev') * 0.15; // 70-85% net to publisher
      const ecpmNet = ecpmGross * revShare;
      const fillRate = 0.6 + pseudo(seed + 'fill') * 0.35;
      const matchRate = fillRate + (1 - fillRate) * (0.5 + pseudo(seed + 'match') * 0.4);
      const adRequests = Math.floor(impressions / fillRate);
      const matchedRequests = Math.floor(adRequests * matchRate);
      const unfilledRequests = Math.max(0, adRequests - impressions);
      const clicks = Math.floor(impressions * ctr);
      const viewabilityRate = 0.5 + pseudo(seed + 'view') * 0.4;
      const revenueGross = (impressions / 1000) * ecpmGross;
      const revenueNet = (impressions / 1000) * ecpmNet;
      const bidRequests = Math.floor(adRequests * (0.6 + pseudo(seed + 'bidreq') * 0.3));
      const bidRate = 0.7 + pseudo(seed + 'bidrate') * 0.25;
      const bidResponses = Math.floor(bidRequests * bidRate);
      const winRate = 0.1 + pseudo(seed + 'win') * 0.3;
      const timeoutRate = pseudo(seed + 'tmout') * 0.05;
      const floorPrice = 0.3 + pseudo(seed + 'floor') * 1.5;
      rows.push({
        dimensions: combo,
        impressions,
        clicks,
        revenue: revenueNet,
        ecpm: ecpmNet,
        ctr: ctr * 100,
        totalRequests: adRequests,
        fillRate,
        ad_requests: adRequests,
        matched_requests: matchedRequests,
        unfilled_requests: unfilledRequests,
        bid_requests: bidRequests,
        bid_responses: bidResponses,
        viewable_impressions: Math.floor(impressions * viewabilityRate),
        revenue_gross: revenueGross,
        revenue_net: revenueNet,
        buyer_spend: revenueGross,
        ecpm_gross: ecpmGross,
        ecpm_net: ecpmNet,
        fill_rate: fillRate,
        match_rate: matchRate,
        viewability_rate: viewabilityRate,
        win_rate: winRate,
        bid_rate: bidRate,
        timeout_rate: timeoutRate,
        floor_price: floorPrice,
        ssp: combo['ssp'] ?? null,
        ad_unit: combo['ad_unit'] ?? null,
        device: combo['device'] ?? null,
        geo: combo['country'] ?? null,
        order_id: combo['order'] ?? null,
        line_item_id: combo['line_item'] ?? null,
        consent_status: pseudo(seed + 'consent') > 0.2 ? 'granted' : 'absent',
        identity_present: pseudo(seed + 'id') > 0.4,
        creative_status: 'ok',
        source_system: 'stub',
        data_freshness_timestamp: fetchedAt,
        warnings: [],
      });
    }
    return rows;
  },
  async listMediaBuys(): Promise<MediaBuy[]> {
    return [
      { id: 'mb_001', name: 'Acme Q2 Branding', status: 'active', budget: 100_000, spend: 47_000, impressions: 4_700_000, clicks: 11_000, startDate: '2026-04-01', endDate: '2026-06-30' },
      { id: 'mb_002', name: 'Beta Promo', status: 'active', budget: 25_000, spend: 24_000, impressions: 1_100_000, clicks: 3_200, startDate: '2026-04-15', endDate: '2026-05-15' },
    ];
  },
  async getMediaBuyDelivery(mediaBuyId: string, dateRange?: { start: string; end: string }): Promise<DeliveryReport[]> {
    const start = dateRange?.start ?? '2026-04-01';
    const end = dateRange?.end ?? '2026-04-07';
    const reports: DeliveryReport[] = [];
    for (const date of eachDate(start, end)) {
      const seed = `${mediaBuyId}-${date}`;
      reports.push({
        mediaBuyId,
        date,
        impressions: Math.floor(pseudo(seed) * 200_000),
        clicks: Math.floor(pseudo(seed + 'c') * 1_000),
        spend: pseudo(seed + 's') * 2_000,
        pacing: 0.5 + pseudo(seed + 'p') * 0.7,
      });
    }
    return reports;
  },
  async checkGovernance(mediaBuyId: string): Promise<GovernanceResult> {
    return { mediaBuyId, passed: true, violations: [] };
  },
  async getProducts(): Promise<InventoryProduct[]> {
    return [
      { id: 'prod_homepage', name: 'Homepage Display', publisherId: 'stub', publisherName: 'Stub Pub', format: 'display', minCpm: 5, availableImpressions: 5_000_000 },
    ];
  },
  async getPlanAuditLogs(): Promise<AuditLogEntry[]> {
    return [
      { id: 'log_001', timestamp: '2026-05-01T12:00:00Z', mediaBuyId: 'mb_001', action: 'create', actor: 'agent:demo', actorType: 'agent', outcome: 'success' },
      { id: 'log_002', timestamp: '2026-05-02T09:15:00Z', mediaBuyId: 'mb_001', action: 'update_budget', actor: 'human:ops', actorType: 'human', outcome: 'success' },
    ];
  },
  async getAllDeliveryReports(dateRange?: { start: string; end: string }): Promise<{ mediaBuy: MediaBuy; reports: DeliveryReport[] }[]> {
    const buys = await this.listMediaBuys();
    return Promise.all(buys.map(async (mb) => ({ mediaBuy: mb, reports: await this.getMediaBuyDelivery(mb.id, dateRange) })));
  },

  async getDealDiagnosticsData(req: { dealIds?: string[]; startDate: string; endDate: string }): Promise<DealMetricRow[]> {
    const fixtures = STUB_DEAL_FIXTURES.map((f) => ({
      ...f,
      data_freshness_timestamp: new Date().toISOString(),
      source_system: 'stub',
    }));
    if (req.dealIds && req.dealIds.length > 0) {
      return fixtures.filter((d) => req.dealIds!.includes(d.deal_id));
    }
    return fixtures;
  },
};

/**
 * Five fixture deals chosen to exercise each diagnostic rule:
 *   1. healthy_pg_001         — healthy PG, no issues, on-track
 *   2. underpacing_supply_002 — underpacing because eligible supply is low
 *   3. low_bid_pmp_003        — PMP with low bid response rate
 *   4. floor_mismatch_004     — floor priced above the bid distribution
 *   5. creative_blocked_005   — creative rejected, deal effectively dead
 */
const STUB_DEAL_FIXTURES: DealMetricRow[] = [
  {
    deal_id: 'healthy_pg_001',
    deal_name: 'Acme Q2 PG — Homepage',
    deal_type: 'programmatic_guaranteed',
    buyer: 'Acme Media',
    dsp: 'TheTradeDesk',
    seat_id: 'ttd-12345',
    ssp: 'magnite',
    booked_impressions: 700_000,
    booked_revenue: 7_000,
    start_date: dateOffset(-10),
    end_date: dateOffset(20),
    eligible_ad_requests: 1_000_000,
    deal_bid_requests: 950_000,
    bid_responses: 720_000,
    valid_bids: 715_000,
    bids_above_floor: 700_000,
    auction_wins: 250_000,
    impressions: 250_000,
    clicks: 1_200,
    buyer_spend: 2_500,
    revenue_net: 2_400,
    floor_price: 8,
    avg_bid_cpm: 12,
    deal_cpm: 10,
    creative_status: 'approved',
    targeting_status: 'ok',
    buyer_status: 'active',
    warnings: [],
    breakdowns: [],
  },
  {
    deal_id: 'underpacing_supply_002',
    deal_name: 'Beta CTV — Sports Verticals',
    deal_type: 'preferred_deal',
    buyer: 'Beta Media',
    dsp: 'DV360',
    ssp: 'magnite',
    booked_impressions: 500_000,
    booked_revenue: 6_000,
    start_date: dateOffset(-15),
    end_date: dateOffset(15),
    // Supply starvation: eligible_ad_requests is far below booked target
    eligible_ad_requests: 80_000,
    deal_bid_requests: 75_000,
    bid_responses: 60_000,
    valid_bids: 55_000,
    bids_above_floor: 50_000,
    auction_wins: 35_000,
    impressions: 35_000,
    clicks: 100,
    buyer_spend: 350,
    revenue_net: 350,
    floor_price: 9,
    avg_bid_cpm: 11,
    deal_cpm: 12,
    creative_status: 'approved',
    targeting_status: 'ok',
    buyer_status: 'active',
    warnings: [],
    breakdowns: [],
  },
  {
    deal_id: 'low_bid_pmp_003',
    deal_name: 'Gamma PMP — Article Premium',
    deal_type: 'private_marketplace',
    buyer: 'Gamma Media',
    dsp: 'Xandr',
    ssp: 'pubmatic',
    booked_impressions: 200_000,
    booked_revenue: 1_400,
    start_date: dateOffset(-5),
    end_date: dateOffset(25),
    eligible_ad_requests: 800_000,
    deal_bid_requests: 800_000,
    // Buyer rarely responds — < 10%
    bid_responses: 60_000,
    valid_bids: 55_000,
    bids_above_floor: 40_000,
    auction_wins: 12_000,
    impressions: 12_000,
    clicks: 50,
    buyer_spend: 80,
    revenue_net: 75,
    floor_price: 5,
    avg_bid_cpm: 7,
    deal_cpm: 6,
    creative_status: 'approved',
    targeting_status: 'ok',
    buyer_status: 'active',
    warnings: [],
    breakdowns: [],
  },
  {
    deal_id: 'floor_mismatch_004',
    deal_name: 'Delta PMP — Sports Display',
    deal_type: 'private_marketplace',
    buyer: 'Delta Brands',
    dsp: 'TheTradeDesk',
    ssp: 'index',
    booked_impressions: 300_000,
    booked_revenue: 4_500,
    start_date: dateOffset(-7),
    end_date: dateOffset(23),
    eligible_ad_requests: 600_000,
    deal_bid_requests: 580_000,
    bid_responses: 400_000,
    valid_bids: 380_000,
    // Floor is way above bid distribution → almost nothing clears
    bids_above_floor: 20_000,
    auction_wins: 8_000,
    impressions: 8_000,
    clicks: 30,
    buyer_spend: 90,
    revenue_net: 80,
    floor_price: 15,
    avg_bid_cpm: 6,
    deal_cpm: 14,
    creative_status: 'approved',
    targeting_status: 'ok',
    buyer_status: 'active',
    warnings: [],
    breakdowns: [],
  },
  {
    deal_id: 'creative_blocked_005',
    deal_name: 'Epsilon — Run-of-Network',
    deal_type: 'preferred_deal',
    buyer: 'Epsilon Brands',
    dsp: 'DV360',
    ssp: 'google_adx',
    booked_impressions: 150_000,
    booked_revenue: 2_000,
    start_date: dateOffset(-3),
    end_date: dateOffset(27),
    eligible_ad_requests: 500_000,
    deal_bid_requests: 480_000,
    bid_responses: 350_000,
    valid_bids: 340_000,
    bids_above_floor: 320_000,
    auction_wins: 0,
    impressions: 0,
    clicks: 0,
    buyer_spend: 0,
    revenue_net: 0,
    floor_price: 4,
    avg_bid_cpm: 8,
    deal_cpm: 7,
    creative_status: 'rejected',
    targeting_status: 'ok',
    buyer_status: 'active',
    warnings: [],
    breakdowns: [],
  },
];

function dateOffset(days: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

const transport = (process.env.ADAM_TRANSPORT ?? 'stdio') as 'stdio' | 'http';
const agent = { id: 'publisher-analytics-stub', name: 'Stub Publisher Analytics Agent', version: '0.1.0' };

if (transport === 'http') {
  const port = process.env.PORT ? Number(process.env.PORT) : 7000;
  const handle = await createPublisherAnalyticsServer({
    transport: 'http',
    dataClient: stubClient,
    agent,
    port,
    bearerToken: process.env.BEARER,
    wellKnownAdagents: { agents: [{ uri: `http://127.0.0.1:${port}/mcp/`, protocol: 'mcp' }] },
    wellKnownBrand: { name: agent.name, analytics_agent: { uri: `http://127.0.0.1:${port}/mcp/`, protocol: 'mcp' } },
  });
  if (handle) process.stderr.write(`stub agent listening on http://127.0.0.1:${handle.port}\n`);
} else {
  await createPublisherAnalyticsServer({ transport: 'stdio', dataClient: stubClient, agent });
}
