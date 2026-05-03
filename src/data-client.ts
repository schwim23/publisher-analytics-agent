import type { MediaBuy, DeliveryReport, GovernanceResult, InventoryProduct, AuditLogEntry, DeliveryRow } from './adcp/types.js';

export type DeliveryDimension = 'date' | 'ad_unit' | 'order' | 'line_item' | 'device' | 'country' | 'ssp';

export interface DeliveryQuery {
  startDate: string;
  endDate: string;
  dimensions: DeliveryDimension[];
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
