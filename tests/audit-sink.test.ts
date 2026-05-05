import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setAuditSink, withAudit, hashParams, paramsKeys, type AuditEvent } from '../src/extension/audit.js';
import { DEV_BYPASS_CONTEXT } from '../src/extension/auth.js';

describe('audit sink', () => {
  let captured: AuditEvent[] = [];
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    captured = [];
    setAuditSink((e) => captured.push(e));
    // Suppress the default stderr writer for this test (in case any path
    // sneaks through without our sink).
    originalStderrWrite = process.stderr.write.bind(process.stderr);
  });

  afterEach(() => {
    // Restore stderr just in case.
    process.stderr.write = originalStderrWrite;
  });

  it('emits an event with hashed params, never the raw params', async () => {
    const sensitiveParams = {
      mediaBuyId: 'mb_secret_001',
      revenue_rows: [
        { ad_unit: 'Premium_Top', revenue_net: 12345.67, ssp: 'magnite' },
        { ad_unit: 'Footer', revenue_net: 234.56, ssp: 'pubmatic' },
      ],
    };
    await withAudit('get_plan_audit_logs', DEV_BYPASS_CONTEXT, sensitiveParams, async () => ({
      structuredContent: { warnings: [{ code: 'STALE_DATA', message: 'x' }] },
    }), (r) => (r as { structuredContent: { warnings: unknown[] } }).structuredContent.warnings.length);

    expect(captured).toHaveLength(1);
    const event = captured[0];

    // Raw param values are NEVER in the event
    const eventJson = JSON.stringify(event);
    expect(eventJson).not.toContain('mb_secret_001');
    expect(eventJson).not.toContain('12345.67');
    expect(eventJson).not.toContain('Premium_Top');
    expect(eventJson).not.toContain('magnite');

    // Hash is present and stable
    expect(event.params_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(event.params_hash).toBe(hashParams(sensitiveParams));

    // Top-level keys are kept (these aren't sensitive — just shape)
    expect(event.params_keys).toEqual(['mediaBuyId', 'revenue_rows']);

    // Other expected fields
    expect(event.tool).toBe('get_plan_audit_logs');
    expect(event.auth_mode).toBe('dev-bypass');
    expect(event.status).toBe('ok');
    expect(event.warnings_count).toBe(1);
    expect(event.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits status=denied when the wrapped fn throws a SCOPE_DENIED-coded error', async () => {
    const denied = Object.assign(new Error('forbidden'), { code: 'SCOPE_DENIED' });
    await expect(
      withAudit('get_inventory_forecast', DEV_BYPASS_CONTEXT, {}, async () => { throw denied; }),
    ).rejects.toThrow('forbidden');

    expect(captured).toHaveLength(1);
    expect(captured[0].status).toBe('denied');
    expect(captured[0].error_code).toBe('SCOPE_DENIED');
  });

  it('emits status=error for any other thrown error', async () => {
    await expect(
      withAudit('get_delivery_summary', DEV_BYPASS_CONTEXT, { startDate: '2025-01-01' }, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(captured).toHaveLength(1);
    expect(captured[0].status).toBe('error');
    expect(captured[0].error_code).toBe('INTERNAL_ERROR');
  });

  it('hashParams is stable for identical inputs and different for different inputs', () => {
    expect(hashParams({ a: 1 })).toBe(hashParams({ a: 1 }));
    expect(hashParams({ a: 1 })).not.toBe(hashParams({ a: 2 }));
  });

  it('paramsKeys returns only top-level keys, capped', () => {
    expect(paramsKeys({ a: 1, b: { c: 2 } })).toEqual(['a', 'b']);
    expect(paramsKeys(null)).toEqual([]);
    const big: Record<string, number> = {};
    for (let i = 0; i < 50; i++) big[`k${i}`] = i;
    expect(paramsKeys(big).length).toBeLessThanOrEqual(32);
  });
});
