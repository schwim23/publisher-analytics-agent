import { describe, it, expect } from 'vitest';
import type { DataClient } from '../src/data-client.js';
import type { MediaBuy, DeliveryReport } from '../src/adcp/types.js';
import { handleGetPacingAlerts } from '../src/tools/pacing-alerts.js';

function buildClient(buys: { mediaBuy: MediaBuy; reports: DeliveryReport[] }[]): DataClient {
  return {
    getDeliveryReport: async () => [],
    listMediaBuys: async () => buys.map((b) => b.mediaBuy),
    getMediaBuyDelivery: async () => [],
    checkGovernance: async () => ({ mediaBuyId: 'x', passed: true, violations: [] }),
    getProducts: async () => [],
    getPlanAuditLogs: async () => [],
    getAllDeliveryReports: async () => buys,
  };
}

describe('pacing alerts', () => {
  it('flags underdelivery with high confidence when flight dates + delivery telemetry exist', async () => {
    const today = new Date();
    const inFlight = (offsetDays: number) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().split('T')[0];

    const client = buildClient([
      {
        mediaBuy: {
          id: 'mb_low_pacing',
          name: 'Underdelivering campaign',
          status: 'active',
          budget: 100_000,
          spend: 30_000,
          impressions: 1_500_000,
          clicks: 5_000,
          startDate: inFlight(-10),
          endDate: inFlight(10),
        },
        reports: [{ mediaBuyId: 'mb_low_pacing', date: inFlight(-1), impressions: 200_000, clicks: 600, spend: 500, pacing: 0.4 }],
      },
    ]);

    const result = await handleGetPacingAlerts(client, { threshold: 0.8 });
    const sc = result.structuredContent as { alerts: Array<{ type: string; severity: string; confidence: string; flight?: { elapsed_fraction?: number | null } }> };
    const alert = sc.alerts.find((a) => a.type === 'underdelivery');
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe('critical'); // pacing 0.4 < 0.5
    expect(alert!.confidence).toBe('high');
    expect(alert!.flight?.elapsed_fraction).toBeGreaterThan(0);
    expect(alert!.flight?.elapsed_fraction).toBeLessThan(1);
  });

  it('emits a MISSING_FLIGHT_DATES warning + lower confidence when flight dates absent', async () => {
    const client = buildClient([
      {
        mediaBuy: {
          id: 'mb_no_flight',
          name: 'No flight metadata',
          status: 'active',
          budget: 50_000,
          spend: 10_000,
          impressions: 100_000,
          clicks: 100,
          startDate: '',
          endDate: '',
        },
        reports: [{ mediaBuyId: 'mb_no_flight', date: '2025-01-15', impressions: 50_000, clicks: 50, spend: 100, pacing: 0.4 }],
      },
    ]);

    const result = await handleGetPacingAlerts(client, { threshold: 0.8 });
    const sc = result.structuredContent as {
      alerts: Array<{ type: string; confidence: string; flight?: unknown }>;
      warnings: Array<{ code: string }>;
    };
    expect(sc.alerts.length).toBeGreaterThan(0);
    expect(sc.warnings.some((w) => w.code === 'MISSING_FLIGHT_DATES')).toBe(true);
    const alert = sc.alerts[0];
    // Without flight dates we still flag pacing but with reduced confidence
    expect(['low', 'medium']).toContain(alert.confidence);
    expect(alert.flight).toBeUndefined();
  });

  it('emits a no_data alert when neither delivery nor budget telemetry is available', async () => {
    const client = buildClient([
      {
        mediaBuy: {
          id: 'mb_silent',
          name: 'Silent buy',
          status: 'active',
          budget: 0,
          spend: 0,
          impressions: 0,
          clicks: 0,
          startDate: '',
          endDate: '',
        },
        reports: [], // no telemetry
      },
    ]);

    const result = await handleGetPacingAlerts(client, { threshold: 0.8 });
    const sc = result.structuredContent as { alerts: Array<{ type: string; severity: string }> };
    expect(sc.alerts.some((a) => a.type === 'no_data')).toBe(true);
  });
});
