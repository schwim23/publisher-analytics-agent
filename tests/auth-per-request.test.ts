import { describe, it, expect } from 'vitest';
import {
  authContextStore,
  currentAuthContext,
  DEV_BYPASS_CONTEXT,
  type AuthContext,
} from '../src/extension/auth.js';

describe('per-request AuthContext via AsyncLocalStorage', () => {
  it('currentAuthContext returns the fallback when no store is bound', () => {
    expect(currentAuthContext(DEV_BYPASS_CONTEXT)).toBe(DEV_BYPASS_CONTEXT);
  });

  it('currentAuthContext returns the per-request store value inside .run()', async () => {
    const perRequest: AuthContext = {
      mode: 'bearer',
      tenant_id: 't_42',
      caller_id: 'bearer:abc123',
      scopes: ['analytics:read'],
    };
    await authContextStore.run(perRequest, async () => {
      const ctx = currentAuthContext(DEV_BYPASS_CONTEXT);
      expect(ctx).toBe(perRequest);
      expect(ctx.tenant_id).toBe('t_42');
      expect(ctx.caller_id).toBe('bearer:abc123');
    });
    // After leaving the store, fallback applies again
    expect(currentAuthContext(DEV_BYPASS_CONTEXT)).toBe(DEV_BYPASS_CONTEXT);
  });

  it('isolates concurrent .run() calls (each request gets its own context)', async () => {
    const a: AuthContext = { mode: 'bearer', tenant_id: 't_a', caller_id: 'a', scopes: ['analytics:read'] };
    const b: AuthContext = { mode: 'bearer', tenant_id: 't_b', caller_id: 'b', scopes: ['audit:read'] };

    const observed = await Promise.all([
      authContextStore.run(a, async () => {
        await new Promise((r) => setImmediate(r));
        return currentAuthContext(DEV_BYPASS_CONTEXT).tenant_id;
      }),
      authContextStore.run(b, async () => {
        await new Promise((r) => setImmediate(r));
        return currentAuthContext(DEV_BYPASS_CONTEXT).tenant_id;
      }),
    ]);

    expect(observed).toEqual(['t_a', 't_b']);
  });
});
