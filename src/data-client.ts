import type { MediaBuy, DeliveryReport, GovernanceResult, InventoryProduct, AuditLogEntry, DeliveryRow } from './adcp/types.js';

export type DeliveryDimension = 'date' | 'ad_unit' | 'order' | 'line_item' | 'device' | 'country' | 'ssp';

/**
 * Typed delivery filter — preferred over the legacy opaque `filter` string in
 * new code. Backends translate the typed fields into whatever their native
 * filter language is (PQL for GAM, query params for AdCP, etc.). Backends
 * SHOULD silently ignore unknown filter keys rather than error.
 */
export interface DeliveryFilter {
  ad_unit?: string;
  ad_unit_ids?: string[];
  line_item_id?: string;
  line_item_ids?: string[];
  order_id?: string;
  deal_id?: string;
  demand_channel?: string;
  device?: string;
  geo?: string;
  format?: string;
  ssp?: string;
  bidder?: string;
}

export interface DeliveryQuery {
  startDate: string;
  endDate: string;
  dimensions: DeliveryDimension[];
  /** Typed filter — use this in new code. */
  delivery_filter?: DeliveryFilter;
  /** @deprecated Backend-specific opaque filter string (e.g. PQL for GAM). Kept
   *  for backward compatibility with existing GAM-flavored tool inputs. New
   *  callers should use `delivery_filter`. */
  filter?: string;
}

export interface DataClient {
  getDeliveryReport(query: DeliveryQuery): Promise<DeliveryRow[]>;
  listMediaBuys(filters?: { status?: string; publisherId?: string }): Promise<MediaBuy[]>;
  getMediaBuyDelivery(mediaBuyId: string, dateRange?: { start: string; end: string }): Promise<DeliveryReport[]>;
  checkGovernance(mediaBuyId: string): Promise<GovernanceResult>;
  getProducts(params: { publisherId?: string; format?: string; brief?: string }): Promise<InventoryProduct[]>;
  getPlanAuditLogs(params: { mediaBuyId?: string; planId?: string; startDate?: string; endDate?: string; limit?: number }): Promise<AuditLogEntry[]>;
  getAllDeliveryReports(dateRange?: { start: string; end: string }): Promise<{ mediaBuy: MediaBuy; reports: DeliveryReport[] }[]>;
  /** Optional: warm a backend-side cache for the given date range. Backends with slow report jobs (e.g. GAM) implement this; in-memory or fast-API backends can omit it. */
  refreshDeliveryCache?(dateRange: { start: string; end: string }): Promise<void>;
}
