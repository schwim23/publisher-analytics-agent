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
   * This is named `getPlanAuditLogs` in the consumer-facing tool surface for backward
   * compatibility with existing Claude Desktop integrations.
   */
  async getPlanAuditLogs(params: {
    mediaBuyId?: string;
    planId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<AuditLogEntry[]> {
    const args: Record<string, unknown> = {};
    if (params.mediaBuyId) args.media_buy_id = params.mediaBuyId;
    if (params.planId) args.plan_id = params.planId;
    if (params.startDate) args.start_date = params.startDate;
    if (params.endDate) args.end_date = params.endDate;
    if (params.limit !== undefined) args.limit = params.limit;
    const res = await this.callTool<{ artifacts?: AuditLogEntry[]; logs?: AuditLogEntry[] } | AuditLogEntry[]>(
      'get_media_buy_artifacts',
      args,
    );
    if (Array.isArray(res)) return res;
    return res.artifacts ?? res.logs ?? [];
  }

  async getDeliveryReport(query: DeliveryQuery): Promise<DeliveryRow[]> {
    const mediaBuys = await this.listMediaBuys({ status: 'active' });
    const results: DeliveryRow[] = [];
    for (const mb of mediaBuys) {
      const reports = await this.getMediaBuyDelivery(mb.id, { start: query.startDate, end: query.endDate });
      for (const r of reports) {
        results.push({
          dimensions: { date: r.date, line_item: mb.name },
          impressions: r.impressions,
          clicks: r.clicks,
          revenue: r.spend,
          ecpm: r.impressions > 0 ? (r.spend / r.impressions) * 1000 : 0,
          ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
          totalRequests: r.impressions,
          fillRate: 1,
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
