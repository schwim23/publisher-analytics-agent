export interface AdCPConfig {
  baseUrl: string;
  apiKey: string;
}

export interface MediaBuy {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'completed' | 'pending';
  budget: number;
  spend: number;
  impressions: number;
  clicks: number;
  startDate: string;
  endDate: string;
  publisherId?: string;
}

export interface DeliveryReport {
  mediaBuyId: string;
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  pacing: number;
}

export interface GovernanceResult {
  mediaBuyId: string;
  passed: boolean;
  violations: GovernanceViolation[];
}

export interface GovernanceViolation {
  rule: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface InventoryProduct {
  id: string;
  name: string;
  publisherId: string;
  publisherName: string;
  format: string;
  minCpm: number;
  availableImpressions: number;
  targeting?: Record<string, string[]>;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  mediaBuyId?: string;
  planId?: string;
  action: string;
  actor: string;
  actorType: 'agent' | 'human';
  outcome: 'success' | 'failure' | 'pending';
  details?: Record<string, unknown>;
}

export interface AdCPError {
  code: string;
  message: string;
}

export interface DeliveryRow {
  dimensions: Record<string, string>;
  impressions: number;
  clicks: number;
  revenue: number;
  ecpm: number;
  ctr: number;
  totalRequests: number;
  fillRate: number;
}
