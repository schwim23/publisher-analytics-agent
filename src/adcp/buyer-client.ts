import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  AdCPConfig,
  MediaBuy,
  DeliveryReport,
  GovernanceResult,
  InventoryProduct,
  AuditLogEntry,
  DeliveryRow,
} from './types.js';
import type { DataClient, DeliveryQuery } from '../data-client.js';

/**
 * AdCP-conformant client. Implements `DataClient` against any server speaking the
 * AdCP 3.0 protocol — MCP/JSON-RPC over HTTP, with `Authorization: Bearer <token>`
 * authentication.
 *
 * The client connects to the AdCP server's `/mcp/` endpoint and invokes the spec's
 * MCP tools (`get_media_buys`, `get_products`, `get_media_buy_delivery`,
 * `get_media_buy_artifacts`, `check_governance`) rather than hitting REST paths
 * (which AdCP 3.0 does not define).
 *
 * **Argument shapes are best-effort against the AdCP 3.0 conventions.** If your
 * conformance suite or server enforces specific keys/casing, override per-tool by
 * subclassing or wrapping the MCP `client` directly via `getRawClient()`. PRs
 * tightening the shapes against ratified spec are welcome.
 */
export class AdCPBuyerClient implements DataClient {
  private readonly endpoint: URL;
  private readonly apiKey: string;
  private readonly mcp: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private connectPromise: Promise<void> | null = null;

  constructor(config: AdCPConfig) {
    const u = new URL(config.baseUrl);
    if (!u.pathname.endsWith('/mcp/') && !u.pathname.endsWith('/mcp')) {
      u.pathname = u.pathname.replace(/\/?$/, '/mcp/');
    }
    this.endpoint = u;
    this.apiKey = config.apiKey;

    this.transport = new StreamableHTTPClientTransport(this.endpoint, {
      requestInit: {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
    });
    this.mcp = new Client(
      { name: 'publisher-analytics-buyer-client', version: '0.1.0' },
      { capabilities: {} },
    );
  }

  /** Lazy connect — first tool call establishes the MCP session. */
  private async ensureConnected(): Promise<void> {
    if (!this.connectPromise) {
      this.connectPromise = this.mcp.connect(this.transport);
    }
    return this.connectPromise;
  }

  /** Escape hatch for callers who need to invoke tools or methods outside this DataClient surface. */
  async getRawClient(): Promise<Client> {
    await this.ensureConnected();
    return this.mcp;
  }

  async close(): Promise<void> {
    if (this.connectPromise) {
      await this.transport.close();
      this.connectPromise = null;
    }
  }

  private async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.ensureConnected();
    const result = (await this.mcp.callTool({ name, arguments: args })) as unknown as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    if (result.isError) {
      throw new Error(`AdCP tool ${name} returned an error: ${extractText(result)}`);
    }
    return parseJsonResult<T>(name, result);
  }

  async listMediaBuys(filters?: { status?: string; publisherId?: string }): Promise<MediaBuy[]> {
    // AdCP 3.0 `get_media_buys` accepts: media_buy_ids, status_filter (single string
    // or array), include_snapshot, include_history, pagination. `publisherId` from
    // our generic DataClient surface has no spec equivalent here and is dropped.
    const args: Record<string, unknown> = {};
    if (filters?.status) args.status_filter = filters.status;
    const res = await this.callTool<{ media_buys?: MediaBuy[] } | MediaBuy[]>('get_media_buys', args);
    return Array.isArray(res) ? res : (res.media_buys ?? []);
  }

  async getMediaBuyDelivery(mediaBuyId: string, dateRange?: { start: string; end: string }): Promise<DeliveryReport[]> {
    const args: Record<string, unknown> = { media_buy_id: mediaBuyId };
    if (dateRange) {
      args.start_date = dateRange.start;
      args.end_date = dateRange.end;
    }
    const res = await this.callTool<{ delivery?: DeliveryReport[] } | DeliveryReport[]>('get_media_buy_delivery', args);
    return Array.isArray(res) ? res : (res.delivery ?? []);
  }

  async checkGovernance(mediaBuyId: string): Promise<GovernanceResult> {
    return this.callTool<GovernanceResult>('check_governance', { media_buy_id: mediaBuyId });
  }

  async getProducts(params: { publisherId?: string; format?: string; brief?: string }): Promise<InventoryProduct[]> {
    // AdCP 3.0 `get_products` requires `buying_mode`. v3 strict sellers will reject
    // calls without it. We default to `wholesale` (catalog listing); if a `brief`
    // is supplied we switch to `brief` mode and pass it through, as the spec
    // requires `brief` whenever `buying_mode` is `"brief"`.
    const args: Record<string, unknown> = params.brief
      ? { buying_mode: 'brief', brief: params.brief }
      : { buying_mode: 'wholesale' };
    const res = await this.callTool<{ products?: InventoryProduct[] } | InventoryProduct[]>('get_products', args);
    return Array.isArray(res) ? res : (res.products ?? []);
  }

  /**
   * Maps the AdCP `get_media_buy_artifacts` tool — the spec's per-buy decision/action trail.
   * Exposed as `getPlanAuditLogs` in the consumer-facing tool surface for backward
   * compatibility with existing Claude Desktop integrations.
   *
   * AdCP shape requirements:
   * - `media_buy_id` is REQUIRED and singular. When the caller doesn't specify one,
   *   we fan out across active buys (the spec's `get_media_buys` default).
   * - Date range goes in `time_range: { start, end }` as ISO 8601 datetimes.
   *   `start` is inclusive, `end` is exclusive (so we add a day to YYYY-MM-DD ends).
   * - `plan_id` and `limit` are not in the spec for this tool. `planId` is dropped;
   *   `limit` is applied client-side to the merged results.
   */
  async getPlanAuditLogs(params: {
    mediaBuyId?: string;
    planId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<AuditLogEntry[]> {
    const buyIds = params.mediaBuyId
      ? [params.mediaBuyId]
      : (await this.listMediaBuys({ status: 'active' })).map((b) => b.id);

    const timeRange = (params.startDate && params.endDate)
      ? {
          start: dateToIsoStart(params.startDate),
          end: dateToIsoExclusiveEnd(params.endDate),
        }
      : undefined;

    const merged: AuditLogEntry[] = [];
    for (const id of buyIds) {
      const args: Record<string, unknown> = { media_buy_id: id };
      if (timeRange) args.time_range = timeRange;
      const res = await this.callTool<{ artifacts?: AuditLogEntry[]; logs?: AuditLogEntry[] } | AuditLogEntry[]>(
        'get_media_buy_artifacts',
        args,
      );
      const items = Array.isArray(res) ? res : (res.artifacts ?? res.logs ?? []);
      merged.push(...items);
    }
    return params.limit !== undefined ? merged.slice(0, params.limit) : merged;
  }

  async getDeliveryReport(query: DeliveryQuery): Promise<DeliveryRow[]> {
    // Important: AdCP `get_media_buy_delivery` returns *buyer-side* delivery data:
    // impressions delivered to that buy and the buyer's reported spend. This is NOT
    // a publisher-revenue source — it's a buyer-spend source. We surface it as
    // `buyer_spend` (and ALSO populate the legacy `revenue` field for backward
    // compat with existing tools, with a warning that it's buyer-derived).
    //
    // Fields we genuinely don't know from this surface are left null:
    //   - ad_requests, matched_requests, unfilled_requests
    //   - fill_rate, match_rate
    //   - publisher revenue_net / revenue_gross
    // Tools downstream must handle nulls.
    const mediaBuys = await this.listMediaBuys({ status: 'active' });
    const results: DeliveryRow[] = [];
    const fetchedAt = new Date().toISOString();
    for (const mb of mediaBuys) {
      const reports = await this.getMediaBuyDelivery(mb.id, { start: query.startDate, end: query.endDate });
      for (const r of reports) {
        const ecpmFromSpend = r.impressions > 0 ? (r.spend / r.impressions) * 1000 : 0;
        const ctr = r.impressions > 0 ? (r.clicks / r.impressions) : null;
        results.push({
          dimensions: { date: r.date, line_item: mb.name },

          // Legacy fields — kept filled for backward compat. `revenue` here is
          // BUYER spend, not publisher revenue. Warnings call this out.
          impressions: r.impressions,
          clicks: r.clicks,
          revenue: r.spend,
          ecpm: ecpmFromSpend,
          ctr: ctr === null ? 0 : ctr * 100,
          totalRequests: 0,
          fillRate: 0,

          // Extended fields — explicit null for things we don't actually know.
          ad_requests: null,
          matched_requests: null,
          unfilled_requests: null,
          buyer_spend: r.spend,
          revenue_gross: null,
          revenue_net: null,
          ecpm_gross: null,
          ecpm_net: null,
          fill_rate: null,
          match_rate: null,
          line_item_id: mb.id,

          source_system: 'adcp-buyer',
          data_freshness_timestamp: fetchedAt,
          warnings: [
            {
              code: 'REVENUE_FROM_BUYER_SPEND',
              message: '`revenue` is the buyer\'s reported spend, not publisher net revenue. Treat as an estimate.',
              severity: 'warning',
              affected_field: 'revenue',
            },
            {
              code: 'NET_VS_GROSS_UNKNOWN',
              message: 'Buyer-side spend has no publisher rev-share applied; net-vs-gross is unknown.',
              severity: 'warning',
            },
            {
              code: 'TOTAL_REQUESTS_UNAVAILABLE',
              message: 'AdCP buyer delivery does not report ad requests; legacy `totalRequests` is reported as 0 and `ad_requests` is null.',
              severity: 'warning',
              affected_field: 'totalRequests',
            },
            {
              code: 'FILL_RATE_UNAVAILABLE',
              message: 'AdCP buyer delivery does not report fill rate; legacy `fillRate` is reported as 0 and `fill_rate` is null.',
              severity: 'warning',
              affected_field: 'fillRate',
            },
          ],
          provenance: {
            source_system: 'adcp-buyer',
            source_task: 'get_media_buy_delivery',
            source_record_id: mb.id,
            source_field: 'spend',
            fetched_at: fetchedAt,
            derivation: 'buyer.spend mapped to revenue + buyer_spend; ecpm = (spend / impressions) * 1000',
          },
        });
      }
    }
    return results;
  }

  async getAllDeliveryReports(dateRange?: { start: string; end: string }): Promise<{ mediaBuy: MediaBuy; reports: DeliveryReport[] }[]> {
    const mediaBuys = await this.listMediaBuys({ status: 'active' });
    return Promise.all(
      mediaBuys.map(async (mb) => ({
        mediaBuy: mb,
        reports: await this.getMediaBuyDelivery(mb.id, dateRange),
      })),
    );
  }
}

function extractText(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return result.content?.map((c) => c.text ?? '').join('\n') ?? '';
}

function parseJsonResult<T>(toolName: string, result: { content?: Array<{ type?: string; text?: string }> }): T {
  const text = extractText(result);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`AdCP tool ${toolName} returned non-JSON content: ${text.slice(0, 200)}`);
  }
}

/** YYYY-MM-DD → ISO 8601 datetime at start-of-day UTC. */
function dateToIsoStart(date: string): string {
  return new Date(`${date}T00:00:00Z`).toISOString();
}

/** YYYY-MM-DD inclusive → ISO 8601 datetime at start-of-next-day UTC (exclusive end). */
function dateToIsoExclusiveEnd(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}
