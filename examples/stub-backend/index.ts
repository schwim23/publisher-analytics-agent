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
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = (h ^ seed.charCodeAt(i)) * 16777619;
  return Math.abs(h) / 0x7fffffff;
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
    for (const combo of combinations(query.dimensions)) {
      const seed = JSON.stringify(combo);
      const impressions = Math.floor(pseudo(seed) * 50_000) + 1_000;
      const ctr = 0.005 + pseudo(seed + 'ctr') * 0.02;
      const ecpm = 1 + pseudo(seed + 'ecpm') * 8;
      const fillRate = 0.6 + pseudo(seed + 'fill') * 0.35;
      const totalRequests = Math.floor(impressions / fillRate);
      const clicks = Math.floor(impressions * ctr);
      const revenue = (impressions / 1000) * ecpm;
      rows.push({
        dimensions: combo,
        impressions,
        clicks,
        revenue,
        ecpm,
        ctr: ctr * 100,
        totalRequests,
        fillRate,
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
