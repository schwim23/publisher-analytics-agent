import { describe, it, expect } from 'vitest';
import { assertScopes, ScopeDeniedError, DEV_BYPASS_CONTEXT, ANON_CONTEXT, type AuthContext, ALL_SCOPES } from '../src/extension/auth.js';

describe('auth + scopes', () => {
  it('dev-bypass passes all tools without scope checks', () => {
    expect(() => assertScopes('get_delivery_summary', DEV_BYPASS_CONTEXT)).not.toThrow();
    expect(() => assertScopes('get_inventory_forecast', DEV_BYPASS_CONTEXT)).not.toThrow();
    expect(() => assertScopes('get_plan_audit_logs', DEV_BYPASS_CONTEXT)).not.toThrow();
  });

  it('anon context is denied for any scoped tool', () => {
    expect(() => assertScopes('get_delivery_summary', ANON_CONTEXT)).toThrow(ScopeDeniedError);
    expect(() => assertScopes('get_inventory_forecast', ANON_CONTEXT)).toThrow(ScopeDeniedError);
  });

  it('bearer with limited scopes denies tools requiring missing scopes', () => {
    const ctx: AuthContext = { mode: 'bearer', scopes: ['analytics:read'], caller_id: 'b' };
    expect(() => assertScopes('get_delivery_summary', ctx)).not.toThrow();
    expect(() => assertScopes('get_inventory_forecast', ctx)).toThrow(ScopeDeniedError);
    expect(() => assertScopes('get_plan_audit_logs', ctx)).toThrow(ScopeDeniedError);
  });

  it('bearer with all scopes passes everything', () => {
    const ctx: AuthContext = { mode: 'bearer', scopes: ALL_SCOPES, caller_id: 'b' };
    expect(() => assertScopes('get_delivery_summary', ctx)).not.toThrow();
    expect(() => assertScopes('get_inventory_forecast', ctx)).not.toThrow();
    expect(() => assertScopes('get_plan_audit_logs', ctx)).not.toThrow();
  });

  it('ScopeDeniedError carries tool name + missing scopes', () => {
    const ctx: AuthContext = { mode: 'bearer', scopes: [], caller_id: 'b' };
    try {
      assertScopes('get_inventory_forecast', ctx);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeDeniedError);
      const err = e as ScopeDeniedError;
      expect(err.tool).toBe('get_inventory_forecast');
      expect(err.required).toContain('analytics:read');
      expect(err.required).toContain('analytics:forecast');
    }
  });
});
