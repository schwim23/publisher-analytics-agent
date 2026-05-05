import type { DataClient } from '../data-client.js';
import {
  planAuditLogsRequestSchema,
  planAuditLogsResponseSchema,
  type PlanAuditLogsRequest,
} from '../extension/schemas.js';
import { structured } from '../extension/tool-result.js';

export const auditLogsSchema = planAuditLogsRequestSchema;

export const auditLogsTool = {
  name: 'get_plan_audit_logs',
  description: 'Publisher-side audit trail for campaigns or plans. The AdCP backend (when used) maps this to the spec\'s `get_media_buy_artifacts` task. Returns empty for backends that don\'t expose an audit trail (e.g. GAM).',
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

export async function handleGetPlanAuditLogs(client: DataClient, args: PlanAuditLogsRequest) {
  const logs = await client.getPlanAuditLogs(args);

  const byOutcome: Record<string, number> = {};
  const byActorType: Record<string, number> = {};
  for (const l of logs) {
    byOutcome[l.outcome] = (byOutcome[l.outcome] ?? 0) + 1;
    byActorType[l.actorType] = (byActorType[l.actorType] ?? 0) + 1;
  }

  const normalizedLogs = logs.map((l) => ({
    id: l.id,
    timestamp: l.timestamp,
    media_buy_id: l.mediaBuyId ?? null,
    plan_id: l.planId ?? null,
    action: l.action,
    actor: l.actor,
    actor_type: l.actorType,
    outcome: l.outcome,
    details: l.details,
  }));

  return structured({
    schema: planAuditLogsResponseSchema,
    data: {
      summary: { total: logs.length, by_outcome: byOutcome, by_actor_type: byActorType },
      logs: normalizedLogs,
      warnings: [],
      generated_at: new Date().toISOString(),
    },
    text: (parsed) => {
      if (parsed.summary.total === 0) return 'No audit log entries match the filter.';
      const outcomes = Object.entries(parsed.summary.by_outcome).map(([o, n]) => `${n} ${o}`).join(', ');
      return `${parsed.summary.total} audit entries (${outcomes}). Showing logs in structured response.`;
    },
  });
}
