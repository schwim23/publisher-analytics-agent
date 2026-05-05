import type { DataClient } from '../data-client.js';
import type { MediaBuy, DeliveryReport } from '../adcp/types.js';
import {
  pacingAlertsRequestSchema,
  pacingAlertsResponseSchema,
  type PacingAlertsRequest,
  type PacingAlert,
  type DataQualityWarning,
} from '../extension/schemas.js';
import { structured } from '../extension/tool-result.js';

export const pacingAlertsSchema = pacingAlertsRequestSchema;

export const pacingAlertsTool = {
  name: 'get_pacing_alerts',
  description: 'Surface line items that are under- or over-pacing relative to their flight schedule. Computes expected pacing from flight dates when available; falls back to spend/budget ratio with reduced confidence when flight dates are missing.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      threshold: { type: 'number', description: 'Pacing threshold 0-1 (default 0.8)' },
    },
  },
};

export async function handleGetPacingAlerts(client: DataClient, args: PacingAlertsRequest) {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];

  const allData = await client.getAllDeliveryReports({ start: yesterday, end: today });

  const alerts: PacingAlert[] = [];
  const topWarnings: DataQualityWarning[] = [];

  for (const { mediaBuy, reports } of allData) {
    alerts.push(...evaluatePacingFor(mediaBuy, reports, args.threshold, topWarnings));
  }

  // Sort: critical → warning → info, then by absolute pacing gap
  alerts.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  return structured({
    schema: pacingAlertsResponseSchema,
    data: {
      alerts,
      total: alerts.length,
      warnings: topWarnings,
      generated_at: new Date().toISOString(),
    },
    text: (parsed) => {
      if (parsed.total === 0) return 'No pacing alerts.';
      const counts = parsed.alerts.reduce<Record<string, number>>((acc, a) => {
        acc[a.severity] = (acc[a.severity] ?? 0) + 1;
        return acc;
      }, {});
      const top = parsed.alerts.slice(0, 3);
      return [
        `${parsed.total} pacing alert(s): ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ')}`,
        ...top.map((a) => `  ${a.severity.toUpperCase()} · ${a.name} — ${a.message}`),
      ].join('\n');
    },
  });
}

function evaluatePacingFor(
  mb: MediaBuy,
  reports: DeliveryReport[],
  threshold: number,
  topWarnings: DataQualityWarning[],
): PacingAlert[] {
  const out: PacingAlert[] = [];
  const warnings: DataQualityWarning[] = [];

  // Spend-based check (cheap, always available)
  const hasBudget = Number.isFinite(mb.budget) && mb.budget > 0;
  const spendRatio = hasBudget ? mb.spend / mb.budget : null;

  // Flight-date based pacing check (preferred, more accurate)
  const flight = parseFlight(mb.startDate, mb.endDate);
  if (!flight) {
    warnings.push({
      code: 'MISSING_FLIGHT_DATES',
      message: `Line item ${mb.id} (${mb.name}) is missing valid flight dates; pacing is computed from spend/budget only with reduced confidence.`,
      severity: 'warning',
      affected_field: 'flight',
    });
  }
  const elapsedFraction = flight ? clamp01(flight.elapsedFraction) : null;

  // Latest pacing report (legacy `pacing` field is 0–1 actual/expected ratio)
  const latest = reports[reports.length - 1];
  const reportPacing = latest && Number.isFinite(latest.pacing) ? latest.pacing : null;

  // Compute confidence: prefer report-driven pacing with flight dates, fall back to spend
  const confidence = reportPacing !== null && flight
    ? 'high'
    : reportPacing !== null
      ? 'medium'
      : flight && spendRatio !== null
        ? 'medium'
        : spendRatio !== null
          ? 'low'
          : 'low';

  // No data path
  if (reportPacing === null && spendRatio === null) {
    out.push({
      line_item_id: mb.id,
      name: mb.name,
      type: 'no_data',
      severity: 'warning',
      message: 'No pacing data available — neither delivery reports nor budget telemetry returned values.',
      recommended_action: 'Verify the line item is active and that the backend exposes delivery + budget for it.',
      confidence: 'low',
      pacing_ratio: null,
      spend_ratio: null,
      flight: flight ? { start: flight.start, end: flight.end, elapsed_fraction: elapsedFraction ?? null } : undefined,
      warnings,
    });
    pushUnique(topWarnings, warnings);
    return out;
  }

  // Underdelivery
  if (reportPacing !== null && reportPacing < threshold) {
    const sev = reportPacing < 0.5 ? 'critical' : 'warning';
    out.push({
      line_item_id: mb.id,
      name: mb.name,
      type: 'underdelivery',
      severity: sev,
      message: `Pacing at ${pct(reportPacing)} of expected delivery${flight ? ` with ${pct(elapsedFraction!)} of flight elapsed` : ''}.`,
      recommended_action: sev === 'critical'
        ? 'Investigate immediately — check creative approvals, targeting, bid floors, and flight start/end alignment.'
        : 'Review targeting constraints and SSP floor prices; consider redirecting budget if recoverable.',
      confidence,
      pacing_ratio: reportPacing,
      spend_ratio: spendRatio,
      flight: flight ? { start: flight.start, end: flight.end, elapsed_fraction: elapsedFraction ?? null } : undefined,
      warnings,
    });
  } else if (reportPacing === null && spendRatio !== null && flight && elapsedFraction !== null && spendRatio < threshold * elapsedFraction - 0.1) {
    // Spend-based fallback: spent less than what flight progress implies
    out.push({
      line_item_id: mb.id,
      name: mb.name,
      type: 'underdelivery',
      severity: 'warning',
      message: `Spend at ${pct(spendRatio)} of budget with ${pct(elapsedFraction)} of flight elapsed (no delivery telemetry).`,
      recommended_action: 'Investigate underdelivery; may be reporting lag or genuine inventory issue.',
      confidence,
      pacing_ratio: null,
      spend_ratio: spendRatio,
      flight: { start: flight.start, end: flight.end, elapsed_fraction: elapsedFraction },
      warnings,
    });
  }

  // Overspend / Overpacing
  if (spendRatio !== null && spendRatio > 0.95) {
    const sev = spendRatio > 1 ? 'critical' : 'warning';
    out.push({
      line_item_id: mb.id,
      name: mb.name,
      type: spendRatio > 1 ? 'overspend' : 'overpacing',
      severity: sev,
      message: `Spend at ${pct(spendRatio)} of budget${flight && elapsedFraction !== null ? ` with ${pct(elapsedFraction)} of flight elapsed` : ''}.`,
      recommended_action: sev === 'critical'
        ? 'Pause or reduce bids immediately to avoid further overrun; reconcile with finance.'
        : 'Reduce bid pressure or extend flight to avoid overspend in remaining days.',
      confidence,
      pacing_ratio: reportPacing,
      spend_ratio: spendRatio,
      flight: flight ? { start: flight.start, end: flight.end, elapsed_fraction: elapsedFraction ?? null } : undefined,
      warnings,
    });
  }

  if (!hasBudget) {
    warnings.push({
      code: 'MISSING_BUDGET',
      message: `Line item ${mb.id} has no budget value; spend-based checks are skipped.`,
      severity: 'info',
      affected_field: 'budget',
    });
  }

  pushUnique(topWarnings, warnings);
  return out;
}

function parseFlight(start?: string, end?: string): { start: string; end: string; elapsedFraction: number } | null {
  if (!start || !end) return null;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  const now = Date.now();
  const elapsed = (now - s) / (e - s);
  return { start, end, elapsedFraction: elapsed };
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function severityRank(s: PacingAlert['severity']): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2;
}

function pushUnique(target: DataQualityWarning[], src: DataQualityWarning[]): void {
  for (const w of src) {
    if (!target.some((t) => t.code === w.code && t.affected_field === w.affected_field)) target.push(w);
  }
}
