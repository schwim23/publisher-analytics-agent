import { createHash } from 'node:crypto';
import type { AuthContext } from './auth.js';

/**
 * Lightweight audit log for tool invocations. Captures who called what, when,
 * with what shape of params (hashed for privacy), and how it ended.
 *
 * Default sink is in-memory ring buffer + structured stderr emit. Embedders
 * can install a custom sink via `setAuditSink()` for shipping to a real
 * audit pipeline.
 *
 * Raw revenue rows are NEVER logged — params are hashed and result is
 * summarized as { status, warnings_count }.
 */

export interface AuditEvent {
  ts: string;
  tool: string;
  auth_mode: AuthContext['mode'];
  tenant_id?: string;
  caller_id?: string;
  params_hash: string;
  params_keys: string[];
  status: 'ok' | 'denied' | 'error';
  warnings_count?: number;
  error_code?: string;
  duration_ms: number;
}

export type AuditSink = (event: AuditEvent) => void;

const ringBuffer: AuditEvent[] = [];
const RING_SIZE = 256;

let sink: AuditSink = (event) => {
  ringBuffer.push(event);
  while (ringBuffer.length > RING_SIZE) ringBuffer.shift();
  process.stderr.write(`[publisher-analytics audit] ${JSON.stringify(event)}\n`);
};

export function setAuditSink(s: AuditSink): void {
  sink = s;
}

export function getRecentAuditEvents(): ReadonlyArray<AuditEvent> {
  return [...ringBuffer];
}

export function hashParams(params: unknown): string {
  const json = JSON.stringify(params ?? null);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

export function paramsKeys(params: unknown): string[] {
  if (!params || typeof params !== 'object') return [];
  return Object.keys(params as Record<string, unknown>).slice(0, 32);
}

export async function withAudit<T>(
  tool: string,
  ctx: AuthContext,
  params: unknown,
  fn: () => Promise<T>,
  warningsCount?: (result: T) => number,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    sink({
      ts: new Date().toISOString(),
      tool,
      auth_mode: ctx.mode,
      tenant_id: ctx.tenant_id,
      caller_id: ctx.caller_id,
      params_hash: hashParams(params),
      params_keys: paramsKeys(params),
      status: 'ok',
      warnings_count: warningsCount ? warningsCount(result) : undefined,
      duration_ms: Date.now() - started,
    });
    return result;
  } catch (err) {
    const isDenied = err instanceof Error && (err as { code?: string }).code === 'SCOPE_DENIED';
    sink({
      ts: new Date().toISOString(),
      tool,
      auth_mode: ctx.mode,
      tenant_id: ctx.tenant_id,
      caller_id: ctx.caller_id,
      params_hash: hashParams(params),
      params_keys: paramsKeys(params),
      status: isDenied ? 'denied' : 'error',
      error_code: (err as { code?: string }).code ?? 'INTERNAL_ERROR',
      duration_ms: Date.now() - started,
    });
    throw err;
  }
}
