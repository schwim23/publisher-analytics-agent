import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AdCPBuyerClient } from '../src/adcp/buyer-client.js';

/**
 * Higher-level tests against `AdCPBuyerClient` that exercise:
 *   - URL normalization (host root → /mcp/)
 *   - Authorization: Bearer header (via transport requestInit)
 *   - getDeliveryReport mapping path
 *   - getMediaBuyDelivery shape unwrapping (wrapped vs raw array)
 *   - warnings + provenance propagation
 *   - no fake fillRate / no fake totalRequests
 *   - buyer spend not treated as publisher net revenue
 *   - error path (isError result becomes a thrown Error)
 *
 * These tests stub at the MCP `Client` boundary — one level above the raw
 * HTTP transport — so they exercise the buyer-client's own translation
 * code (argument shaping, JSON unwrapping, derivations) without requiring
 * a live AdCP server.
 */

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

function buildBuyer(handler: (call: ToolCall) => unknown | { __error: string }): { buyer: AdCPBuyerClient; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const buyer = new AdCPBuyerClient({ baseUrl: 'http://stub.example/', apiKey: 'test-token' });
  const fakeMcp = {
    connect: async () => { /* noop */ },
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const call: ToolCall = { name, args };
      calls.push(call);
      const result = handler(call);
      if (result && typeof result === 'object' && '__error' in result) {
        return { content: [{ type: 'text', text: (result as { __error: string }).__error }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
    },
  } as unknown as Client;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (buyer as any).mcp = fakeMcp;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (buyer as any).connectPromise = Promise.resolve();
  return { buyer, calls };
}

describe('AdCPBuyerClient URL + auth wiring', () => {
  it('normalizes a host-root baseUrl to /mcp/ on the transport endpoint', () => {
    const buyer = new AdCPBuyerClient({ baseUrl: 'https://adcp.example.com', apiKey: 'k' });
    // Inspect the internally constructed URL via the transport. The transport
    // is private, but the URL object is preserved.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ep: URL = (buyer as any).endpoint;
    expect(ep.pathname).toBe('/mcp/');
    expect(ep.host).toBe('adcp.example.com');
  });

  it('keeps a baseUrl that already ends with /mcp', () => {
    const buyer = new AdCPBuyerClient({ baseUrl: 'https://adcp.example.com/mcp', apiKey: 'k' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ep: URL = (buyer as any).endpoint;
    expect(ep.pathname).toMatch(/^\/mcp\/?$/);
  });

  it('attaches Authorization: Bearer <token> to the transport requestInit', () => {
    const buyer = new AdCPBuyerClient({ baseUrl: 'https://adcp.example.com', apiKey: 'sekret' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = (buyer as any).transport;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestInit = (transport as any)._requestInit;
    expect(requestInit?.headers?.Authorization).toBe('Bearer sekret');
  });
});

describe('AdCPBuyerClient.getMediaBuyDelivery shape unwrapping', () => {
  it('handles `{ delivery: [...] }` wrapper', async () => {
    const { buyer } = buildBuyer((call) => {
      if (call.name === 'get_media_buy_delivery') {
        return { delivery: [{ mediaBuyId: 'mb1', date: '2025-01-15', impressions: 1000, clicks: 5, spend: 50, pacing: 0.9 }] };
      }
      throw new Error(`unexpected ${call.name}`);
    });
    const reports = await buyer.getMediaBuyDelivery('mb1');
    expect(reports).toHaveLength(1);
    expect(reports[0].impressions).toBe(1000);
  });

  it('handles a raw array result (no wrapper)', async () => {
    const { buyer } = buildBuyer((call) => {
      if (call.name === 'get_media_buy_delivery') {
        return [{ mediaBuyId: 'mb1', date: '2025-01-15', impressions: 1000, clicks: 5, spend: 50, pacing: 0.9 }];
      }
      throw new Error(`unexpected ${call.name}`);
    });
    const reports = await buyer.getMediaBuyDelivery('mb1');
    expect(reports).toHaveLength(1);
    expect(reports[0].spend).toBe(50);
  });

  it('returns [] when no delivery found (empty wrapper)', async () => {
    const { buyer } = buildBuyer(() => ({ delivery: [] }));
    expect(await buyer.getMediaBuyDelivery('mb1')).toEqual([]);
  });
});

describe('AdCPBuyerClient.getDeliveryReport mapping', () => {
  it('aggregates across active media buys, preserves warnings + provenance, leaves fill_rate null', async () => {
    const { buyer, calls } = buildBuyer((call) => {
      if (call.name === 'get_media_buys') {
        return {
          media_buys: [
            { id: 'mb_a', name: 'Acme Q1', status: 'active', budget: 100_000, spend: 47_000, impressions: 4_700_000, clicks: 11_000, startDate: '2025-01-01', endDate: '2025-03-31' },
            { id: 'mb_b', name: 'Beta Promo', status: 'active', budget: 25_000, spend: 24_000, impressions: 1_100_000, clicks: 3_200, startDate: '2025-01-15', endDate: '2025-02-15' },
          ],
        };
      }
      if (call.name === 'get_media_buy_delivery') {
        const id = call.args.media_buy_id as string;
        return [{ mediaBuyId: id, date: '2025-01-20', impressions: 100_000, clicks: 250, spend: 500, pacing: 0.95 }];
      }
      throw new Error(`unexpected ${call.name}`);
    });

    const rows = await buyer.getDeliveryReport({ startDate: '2025-01-20', endDate: '2025-01-20', dimensions: ['date'] });

    // Two buys × 1 day = 2 rows.
    expect(rows).toHaveLength(2);

    // get_media_buys was called with status_filter, NOT a misnamed `status` field
    const listCall = calls.find((c) => c.name === 'get_media_buys');
    expect(listCall?.args).toMatchObject({ status_filter: 'active' });
    expect(listCall?.args).not.toHaveProperty('status');
    expect(listCall?.args).not.toHaveProperty('media_buy_ids'); // empty → omitted

    for (const r of rows) {
      // Buyer spend is preserved; legacy revenue holds buyer spend; net/gross are null
      expect(r.buyer_spend).toBe(500);
      expect(r.revenue).toBe(500);
      expect(r.revenue_net).toBeNull();
      expect(r.revenue_gross).toBeNull();

      // Fill / requests are explicitly null + 0 (no fakery)
      expect(r.fill_rate).toBeNull();
      expect(r.ad_requests).toBeNull();
      expect(r.totalRequests).toBe(0);
      expect(r.fillRate).toBe(0);

      // Warnings cover all four documented mapping concerns
      const codes = (r.warnings ?? []).map((w) => w.code);
      expect(codes).toContain('REVENUE_FROM_BUYER_SPEND');
      expect(codes).toContain('NET_VS_GROSS_UNKNOWN');
      expect(codes).toContain('FILL_RATE_UNAVAILABLE');
      expect(codes).toContain('TOTAL_REQUESTS_UNAVAILABLE');

      // Provenance points back at the AdCP task and the source record
      expect(r.provenance?.source_system).toBe('adcp-buyer');
      expect(r.provenance?.source_task).toBe('get_media_buy_delivery');
      expect(['mb_a', 'mb_b']).toContain(r.provenance?.source_record_id);
      expect(r.source_system).toBe('adcp-buyer');
      expect(r.data_freshness_timestamp).toBeTruthy();
    }
  });
});

describe('AdCPBuyerClient.getProducts argument shape', () => {
  it('always sends buying_mode (defaults to wholesale)', async () => {
    const { buyer, calls } = buildBuyer(() => ({ products: [] }));
    await buyer.getProducts({});
    const call = calls.find((c) => c.name === 'get_products');
    expect(call?.args.buying_mode).toBe('wholesale');
  });

  it('switches to buying_mode: brief when a brief is supplied', async () => {
    const { buyer, calls } = buildBuyer(() => ({ products: [] }));
    await buyer.getProducts({ brief: 'High-viewability premium homepage' });
    const call = calls.find((c) => c.name === 'get_products');
    expect(call?.args.buying_mode).toBe('brief');
    expect(call?.args.brief).toBe('High-viewability premium homepage');
  });
});

describe('AdCPBuyerClient.getPlanAuditLogs', () => {
  it('uses singular media_buy_id and packs date range into time_range with ISO 8601 datetimes', async () => {
    const { buyer, calls } = buildBuyer((call) => {
      if (call.name === 'get_media_buy_artifacts') {
        return { artifacts: [] };
      }
      throw new Error(`unexpected ${call.name}`);
    });
    await buyer.getPlanAuditLogs({
      mediaBuyId: 'mb_x',
      startDate: '2025-01-01',
      endDate: '2025-01-07',
      limit: 50,
    });
    const call = calls.find((c) => c.name === 'get_media_buy_artifacts');
    expect(call?.args.media_buy_id).toBe('mb_x');
    expect(call?.args.media_buy_ids).toBeUndefined();
    const tr = call?.args.time_range as { start: string; end: string };
    expect(tr.start).toBe('2025-01-01T00:00:00.000Z');
    // End is exclusive — it advances by one day
    expect(tr.end).toBe('2025-01-08T00:00:00.000Z');
  });

  it('fans out across active media buys when no mediaBuyId is supplied', async () => {
    const { buyer, calls } = buildBuyer((call) => {
      if (call.name === 'get_media_buys') return { media_buys: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
      if (call.name === 'get_media_buy_artifacts') return { artifacts: [] };
      throw new Error(`unexpected ${call.name}`);
    });
    await buyer.getPlanAuditLogs({ limit: 10 });
    const artifactCalls = calls.filter((c) => c.name === 'get_media_buy_artifacts');
    expect(artifactCalls).toHaveLength(3);
    expect(artifactCalls.map((c) => c.args.media_buy_id).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('AdCPBuyerClient error path', () => {
  it('throws when the underlying tool result has isError: true', async () => {
    const { buyer } = buildBuyer((call) => {
      if (call.name === 'get_media_buys') return { __error: 'boom' };
      return [];
    });
    await expect(buyer.listMediaBuys()).rejects.toThrow(/get_media_buys.*boom/);
  });
});
