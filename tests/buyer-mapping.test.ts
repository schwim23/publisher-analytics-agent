import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AdCPBuyerClient } from '../src/adcp/buyer-client.js';

/**
 * The buyer client wraps an MCP client. To test the response-to-DataClient
 * mapping without a network, we construct the buyer client and stub its
 * underlying MCP `callTool` so we control what comes back.
 */
function buildBuyerWithFakeTool(handler: (name: string, args: Record<string, unknown>) => unknown): AdCPBuyerClient {
  const buyer = new AdCPBuyerClient({ baseUrl: 'http://stub/', apiKey: 'x' });
  const fakeMcp = {
    connect: async () => { /* noop */ },
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const result = handler(name, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: false,
      };
    },
  } as unknown as Client;
  // monkey-patch internal mcp client + connection promise
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (buyer as any).mcp = fakeMcp;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (buyer as any).connectPromise = Promise.resolve();
  return buyer;
}

describe('AdCPBuyerClient.getDeliveryReport', () => {
  it('marks revenue as buyer-spend-derived and nulls fill_rate / total_requests', async () => {
    const buyer = buildBuyerWithFakeTool((name, args) => {
      if (name === 'get_media_buys') {
        return {
          media_buys: [
            { id: 'mb_1', name: 'Acme Q1', status: 'active', budget: 100000, spend: 47000, impressions: 4_700_000, clicks: 11_000, startDate: '2025-01-01', endDate: '2025-03-31' },
          ],
        };
      }
      if (name === 'get_media_buy_delivery') {
        expect(args.media_buy_id).toBe('mb_1');
        return {
          delivery: [
            { mediaBuyId: 'mb_1', date: '2025-01-15', impressions: 100_000, clicks: 250, spend: 500, pacing: 0.95 },
          ],
        };
      }
      throw new Error(`unexpected tool: ${name}`);
    });

    const rows = await buyer.getDeliveryReport({ startDate: '2025-01-15', endDate: '2025-01-15', dimensions: ['date'] });

    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.buyer_spend).toBe(500);
    expect(r.revenue).toBe(500); // legacy field carries buyer spend
    expect(r.revenue_net).toBeNull();
    expect(r.revenue_gross).toBeNull();
    expect(r.fill_rate).toBeNull();
    expect(r.ad_requests).toBeNull();
    expect(r.totalRequests).toBe(0);
    expect(r.fillRate).toBe(0);

    // warnings present for the four known mapping issues
    expect(r.warnings?.some((w) => w.code === 'REVENUE_FROM_BUYER_SPEND')).toBe(true);
    expect(r.warnings?.some((w) => w.code === 'FILL_RATE_UNAVAILABLE')).toBe(true);
    expect(r.warnings?.some((w) => w.code === 'TOTAL_REQUESTS_UNAVAILABLE')).toBe(true);
    expect(r.warnings?.some((w) => w.code === 'NET_VS_GROSS_UNKNOWN')).toBe(true);

    // provenance present and points at the right task
    expect(r.provenance?.source_system).toBe('adcp-buyer');
    expect(r.provenance?.source_task).toBe('get_media_buy_delivery');
    expect(r.provenance?.source_record_id).toBe('mb_1');
  });
});
