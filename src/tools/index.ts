import type { DataClient } from '../data-client.js';
import type { AuthContext } from '../extension/auth.js';
import { assertScopes, currentAuthContext } from '../extension/auth.js';
import { withAudit } from '../extension/audit.js';
import { deliverySummaryTool, deliverySummarySchema, handleGetDeliverySummary } from './delivery-summary.js';
import { pacingAlertsTool, pacingAlertsSchema, handleGetPacingAlerts } from './pacing-alerts.js';
import { morningBriefingTool, morningBriefingSchema, handleGetMorningBriefing } from './morning-briefing.js';
import { yieldAnomaliesTool, yieldAnomaliesSchema, handleGetYieldAnomalies } from './yield-anomalies.js';
import { inventoryForecastTool, inventoryForecastSchema, handleGetInventoryForecast } from './inventory-forecast.js';
import { comparePeriodsTool, comparePeriodsSchema, handleComparePeriods } from './compare-periods.js';
import { auditLogsTool, auditLogsSchema, handleGetPlanAuditLogs } from './audit-logs.js';
import { dealDiagnosticsTool, dealDiagnosticsSchema, handleGetDealDiagnostics } from './deal-diagnostics.js';
import { visualizationTool, visualizationSchema, handleGenerateVisualization } from './visualization.js';
import { capabilitiesTool, handleGetAdcpCapabilities, type CapabilitiesContext } from '../adcp/capabilities.js';

export const tools = [
  capabilitiesTool,
  deliverySummaryTool,
  pacingAlertsTool,
  morningBriefingTool,
  yieldAnomaliesTool,
  inventoryForecastTool,
  comparePeriodsTool,
  auditLogsTool,
  dealDiagnosticsTool,
  visualizationTool,
];

export async function handleToolCall(
  client: DataClient,
  capabilitiesContext: CapabilitiesContext,
  authContext: AuthContext,
  name: string,
  args: Record<string, unknown>,
) {
  // Prefer the per-request context from AsyncLocalStorage (populated by the
  // HTTP transport for each call). Fall back to the explicit `authContext`
  // argument used by stdio mode. This keeps stdio simple while letting HTTP
  // pass per-request bearer + tenant + scopes without a global mutable.
  const ctx = currentAuthContext(authContext);
  assertScopes(name, ctx);

  return withAudit(name, ctx, args, async () => {
    switch (name) {
      case 'get_adcp_capabilities':
        return handleGetAdcpCapabilities(capabilitiesContext);
      case 'get_delivery_summary':
        return handleGetDeliverySummary(client, deliverySummarySchema.parse(args));
      case 'get_pacing_alerts':
        return handleGetPacingAlerts(client, pacingAlertsSchema.parse(args));
      case 'get_morning_briefing':
        return handleGetMorningBriefing(client, morningBriefingSchema.parse(args));
      case 'get_yield_anomalies':
        return handleGetYieldAnomalies(client, yieldAnomaliesSchema.parse(args));
      case 'get_inventory_forecast':
        return handleGetInventoryForecast(client, inventoryForecastSchema.parse(args));
      case 'compare_periods':
        return handleComparePeriods(client, comparePeriodsSchema.parse(args));
      case 'get_plan_audit_logs':
        return handleGetPlanAuditLogs(client, auditLogsSchema.parse(args));
      case 'get_deal_diagnostics':
        return handleGetDealDiagnostics(client, dealDiagnosticsSchema.parse(args));
      case 'generate_visualization':
        return handleGenerateVisualization(visualizationSchema.parse(args));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }, (result) => extractWarningCount(result));
}

function extractWarningCount(result: unknown): number {
  const r = result as { structuredContent?: { warnings?: unknown[] } };
  const w = r?.structuredContent?.warnings;
  return Array.isArray(w) ? w.length : 0;
}
