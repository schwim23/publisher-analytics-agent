import { z } from 'zod';
import type { DataClient } from '../data-client.js';

export const auditLogsSchema = z.object({
  mediaBuyId: z.string().optional().describe('Filter by campaign/media buy ID'),
  planId: z.string().optional().describe('Filter by plan ID'),
  startDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
  endDate: z.string().optional().describe('End date (YYYY-MM-DD)'),
  limit: z.number().int().min(1).max(500).default(100).describe('Max entries to return (default 100)'),
});

export const auditLogsTool = {
  name: 'get_plan_audit_logs',
  description: 'Retrieve the AdCP audit trail for campaigns or plans — who did what, when, and whether it succeeded. Useful for compliance reporting, debugging delivery issues, and understanding agent decision history.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      mediaBuyId: { type: 'string', description: 'Filter by campaign/media buy ID' },
      planId: { type: 'string', description: 'Filter by plan ID' },
      startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      limit: { type: 'number', description: 'Max entries to return (default 100, max 500)' },
    },
  },
};

export async function handleGetPlanAuditLogs(
  client: DataClient,
  args: z.infer<typeof auditLogsSchema>
) {
  const logs = await client.getPlanAuditLogs(args);

  const summary = {
    total: logs.length,
    byOutcome: logs.reduce<Record<string, number>>((acc, l) => {
      acc[l.outcome] = (acc[l.outcome] ?? 0) + 1;
      return acc;
    }, {}),
    byActorType: logs.reduce<Record<string, number>>((acc, l) => {
      acc[l.actorType] = (acc[l.actorType] ?? 0) + 1;
      return acc;
    }, {}),
  };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ summary, logs, fetchedAt: new Date().toISOString() }, null, 2),
    }],
  };
}
