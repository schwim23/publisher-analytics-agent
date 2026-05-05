import { describe, it, expect } from 'vitest';
import {
  deliverySummaryRequestSchema,
  deliverySummaryResponseSchema,
  pacingAlertsRequestSchema,
  pacingAlertSchema,
  yieldAnomaliesRequestSchema,
  inventoryForecastRequestSchema,
  comparePeriodsRequestSchema,
  visualizationRequestSchema,
  hypothesisSchema,
  dataQualityWarningSchema,
  EXTENSION_VERSION,
  EXTENSION_SCHEMA_VERSION,
} from '../src/extension/schemas.js';

describe('extension schemas', () => {
  it('exposes a stable extension version pair', () => {
    expect(EXTENSION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(EXTENSION_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('rejects malformed dates in deliverySummaryRequest', () => {
    expect(() => deliverySummaryRequestSchema.parse({
      startDate: '2025/01/01',
      endDate: '2025-01-31',
    })).toThrow(/YYYY-MM-DD/);
  });

  it('defaults dimensions to ["date"] in deliverySummaryRequest', () => {
    const parsed = deliverySummaryRequestSchema.parse({
      startDate: '2025-01-01',
      endDate: '2025-01-31',
    });
    expect(parsed.dimensions).toEqual(['date']);
  });

  it('clamps fill_rate to [0,1] in deliverySummaryResponse rows', () => {
    expect(() => deliverySummaryResponseSchema.parse({
      period: { start: '2025-01-01', end: '2025-01-31' },
      dimensions: ['date'],
      totals: {},
      rows: [{ dimensions: {}, fill_rate: 1.5, warnings: [] }],
      row_count: 1,
      generated_at: new Date().toISOString(),
    })).toThrow();
  });

  it('defaults pacingAlerts threshold to 0.8', () => {
    const parsed = pacingAlertsRequestSchema.parse({});
    expect(parsed.threshold).toBe(0.8);
  });

  it('requires line_item_id and severity on pacingAlert', () => {
    expect(() => pacingAlertSchema.parse({})).toThrow();
    const ok = pacingAlertSchema.parse({
      line_item_id: 'mb_001',
      name: 'Test buy',
      type: 'underdelivery',
      severity: 'warning',
      message: 'pacing low',
      recommended_action: 'investigate',
      confidence: 'medium',
    });
    expect(ok.warnings).toEqual([]);
  });

  it('requires lookbackDays >= 2 for yield anomalies', () => {
    expect(() => yieldAnomaliesRequestSchema.parse({ lookbackDays: 1 })).toThrow();
    const parsed = yieldAnomaliesRequestSchema.parse({});
    expect(parsed.lookbackDays).toBe(14);
    expect(parsed.dimensions).toEqual(['ad_unit']);
    expect(parsed.minImpressions).toBe(1000);
  });

  it('inventory forecast requires adUnit + dates', () => {
    expect(() => inventoryForecastRequestSchema.parse({ startDate: '2025-01-01', endDate: '2025-01-07' })).toThrow();
    const ok = inventoryForecastRequestSchema.parse({
      adUnit: 'Homepage_Top',
      startDate: '2025-01-01',
      endDate: '2025-01-07',
    });
    expect(ok.adUnit).toBe('Homepage_Top');
  });

  it('compare_periods restricts metric enum', () => {
    expect(() => comparePeriodsRequestSchema.parse({
      metric: 'unknown_metric',
      periodA: { start: '2025-01-01', end: '2025-01-07' },
      periodB: { start: '2025-01-08', end: '2025-01-14' },
    })).toThrow();
  });

  it('visualization requires at least one series', () => {
    expect(() => visualizationRequestSchema.parse({
      chartType: 'line', title: 't', data: '[]', xKey: 'x', series: [],
    })).toThrow();
  });

  it('hypothesis defaults evidence and recommended_next_checks to []', () => {
    const h = hypothesisSchema.parse({ label: 'demo', confidence: 'low' });
    expect(h.evidence).toEqual([]);
    expect(h.recommended_next_checks).toEqual([]);
  });

  it('dataQualityWarning has a constrained code enum', () => {
    expect(() => dataQualityWarningSchema.parse({ code: 'NOT_A_REAL_CODE', message: 'x' })).toThrow();
    const w = dataQualityWarningSchema.parse({ code: 'FILL_RATE_UNAVAILABLE', message: 'x' });
    expect(w.severity).toBe('warning');
  });
});
