/**
 * Auth context + scope enforcement for the publisher-analytics extension.
 *
 * Publisher revenue data is sensitive. Tools that touch it should run inside
 * an `AuthContext` carrying tenant/caller identity and scopes the caller has.
 * In HTTP mode the context is derived from the bearer token per request and
 * carried via AsyncLocalStorage so MCP request handlers (which don't see the
 * raw HTTP req) can access it. In stdio/Claude-Desktop mode we run as a
 * dev bypass, clearly labeled, with scopes set to a fully-permissive
 * superset and `mode: 'dev-bypass'` so the audit log captures the gap.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type Scope =
  | 'analytics:read'
  | 'analytics:forecast'
  | 'analytics:visualize'
  | 'audit:read'
  | 'capabilities:read';

export const ALL_SCOPES: readonly Scope[] = [
  'analytics:read',
  'analytics:forecast',
  'analytics:visualize',
  'audit:read',
  'capabilities:read',
] as const;

export interface AuthContext {
  /** "dev-bypass" for stdio/local; "bearer" for HTTP bearer-auth; "anon" for unauthenticated public endpoints. */
  mode: 'dev-bypass' | 'bearer' | 'anon';
  tenant_id?: string;
  caller_id?: string;
  scopes: ReadonlyArray<Scope>;
}

export const DEV_BYPASS_CONTEXT: AuthContext = {
  mode: 'dev-bypass',
  caller_id: 'local-dev',
  scopes: ALL_SCOPES,
};

export const ANON_CONTEXT: AuthContext = {
  mode: 'anon',
  scopes: [],
};

/** Per-tool required scopes. Missing entry → no scope required (e.g. `get_adcp_capabilities`). */
export const TOOL_SCOPES: Record<string, Scope[]> = {
  get_adcp_capabilities: ['capabilities:read'],
  get_delivery_summary: ['analytics:read'],
  get_pacing_alerts: ['analytics:read'],
  get_morning_briefing: ['analytics:read'],
  get_yield_anomalies: ['analytics:read'],
  get_inventory_forecast: ['analytics:read', 'analytics:forecast'],
  compare_periods: ['analytics:read'],
  get_plan_audit_logs: ['audit:read'],
  generate_visualization: ['analytics:visualize'],
};

export class ScopeDeniedError extends Error {
  readonly code = 'SCOPE_DENIED';
  constructor(public readonly tool: string, public readonly required: Scope[], public readonly granted: ReadonlyArray<Scope>) {
    super(`Tool '${tool}' requires scope(s) [${required.join(', ')}]; caller has [${granted.join(', ')}]`);
  }
}

export function assertScopes(tool: string, ctx: AuthContext): void {
  const required = TOOL_SCOPES[tool] ?? [];
  if (required.length === 0) return;
  if (ctx.mode === 'dev-bypass') return; // local-dev convenience; logged in audit
  const missing = required.filter((s) => !ctx.scopes.includes(s));
  if (missing.length) throw new ScopeDeniedError(tool, missing, ctx.scopes);
}

/**
 * Per-request AuthContext store. The HTTP transport runs each `transport.handleRequest`
 * inside `authContextStore.run(perRequestCtx, ...)` so MCP request handlers (which
 * receive only `request.params`, not the raw HTTP req) can pull the active
 * auth context out of ALS. The dispatch layer prefers the ALS value if present;
 * the explicit `ctx` argument is the fallback used by stdio.
 */
export const authContextStore = new AsyncLocalStorage<AuthContext>();

/** Returns the per-request auth context if running inside `authContextStore.run`, else `fallback`. */
export function currentAuthContext(fallback: AuthContext): AuthContext {
  return authContextStore.getStore() ?? fallback;
}
