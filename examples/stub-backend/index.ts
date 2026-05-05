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
    const fetchedAt = new Date().toISOString();
    for (const combo of combinations(query.dimensions)) {
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
};

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
