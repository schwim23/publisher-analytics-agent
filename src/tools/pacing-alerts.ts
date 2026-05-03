import { z } from 'zod';
import type { DataClient } from '../data-client.js';

export const pacingAlertsSchema = z.object({
  threshold: z.number().min(0).max(1).default(0.8)
    .describe('Flag line items pacing below this ratio (default 0.8 = 80%)'),
});

export const pacingAlertsTool = {
  name: 'get_pacing_alerts',
  description: 'Surface line items that are under- or over-delivering relative to their flight schedule. Includes budget utilization warnings and governance issues.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      threshold: { type: 'number', description: 'Pacing threshold 0-1 (default 0.8)' },
    },
  },
};

export async function handleGetPacingAlerts(client: DataClient, args: z.infer<typeof pacingAlertsSchema>) {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];

  const allData = await client.getAllDeliveryReports({ start: yesterday, end: today });

  interface Alert {
    lineItemId: string;
    name: string;
    type: 'underdelivery' | 'overspend' | 'governance';
    severity: 'critical' | 'warning';
    message: string;
    recommendation: string;
  }

  const alerts: Alert[] = [];

  for (const { mediaBuy, reports } of allData) {
    const latest = reports[reports.length - 1];
    if (latest && latest.pacing < args.threshold) {
      alerts.push({
        lineItemId: mediaBuy.id,
        name: mediaBuy.name,
        type: 'underdelivery',
        severity: latest.pacing < 0.5 ? 'critical' : 'warning',
        message: `Pacing at ${Math.round(latest.pacing * 100)}% of expected delivery`,
        recommendation: latest.pacing < 0.5
          ? 'Investigate immediately — check creative approvals, targeting, and bid floors'
          : 'Review targeting constraints and SSP floor prices',
      });
    }

    const spendRatio = mediaBuy.budget > 0 ? mediaBuy.spend / mediaBuy.budget : 0;
    if (spendRatio > 0.95) {
      alerts.push({
        lineItemId: mediaBuy.id,
        name: mediaBuy.name,
        type: 'overspend',
        severity: spendRatio > 1 ? 'critical' : 'warning',
        message: `Spend at ${Math.round(spendRatio * 100)}% of budget`,
        recommendation: 'Pause or reduce bid to avoid overrun',
      });
    }
  }

  alerts.sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1));

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ alerts, total: alerts.length, fetchedAt: new Date().toISOString() }, null, 2),
    }],
  };
}
