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
 * AdCP-spec HTTP client. Implements `DataClient`, so it can serve as a backend for the
 * publisher-analytics-agent when delivery data lives behind an AdCP-conformant server
 * (rather than being read from a native ad-server SOAP/REST API).
 *
 * In a typical deployment this is also the surface used to reach buyer-side AdCP agents
 * for cross-checks against publisher-side numbers — e.g., comparing `getMediaBuyDelivery`
 * results against the publisher's own delivery reports.
 */
export class AdCPBuyerClient implements DataClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: AdCPConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`AdCP ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async listMediaBuys(filters?: { status?: string; publisherId?: string }): Promise<MediaBuy[]> {
    const params = new URLSearchParams(filters as Record<string, string>);
    return this.request<MediaBuy[]>(`/v1/media-buys?${params}`);
  }

  async getMediaBuyDelivery(mediaBuyId: string, dateRange?: { start: string; end: string }): Promise<DeliveryReport[]> {
    const params = new URLSearchParams(dateRange as Record<string, string>);
    return this.request<DeliveryReport[]>(`/v1/media-buys/${mediaBuyId}/delivery?${params}`);
  }

  async checkGovernance(mediaBuyId: string): Promise<GovernanceResult> {
    return this.request<GovernanceResult>(`/v1/governance/check`, {
      method: 'POST',
      body: JSON.stringify({ media_buy_id: mediaBuyId }),
    });
  }

  async getProducts(params: { publisherId?: string; format?: string; brief?: string }): Promise<InventoryProduct[]> {
    const qs = new URLSearchParams(params as Record<string, string>);
    return this.request<InventoryProduct[]>(`/v1/products?${qs}`);
  }

  async getPlanAuditLogs(params: {
    mediaBuyId?: string;
    planId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<AuditLogEntry[]> {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])),
    );
    return this.request<AuditLogEntry[]>(`/v1/audit-logs?${qs}`);
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
