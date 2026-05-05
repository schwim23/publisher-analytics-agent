import type { z } from 'zod';

/**
 * MCP tool-result helper.
 *
 * Returns both:
 *   - `structuredContent`: the validated response object (consumed by agents)
 *   - `content`: a concise human-readable summary (rendered in chat clients)
 *
 * The caller passes a Zod schema, the result object, and a function that
 * generates the text summary. The schema parses (and may default-fill) the
 * result so callers don't have to pre-validate.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export function structured<T>(opts: {
  schema: z.ZodType<T>;
  data: unknown;
  text: (parsed: T) => string;
}): ToolResult {
  const parsed = opts.schema.parse(opts.data);
  return {
    structuredContent: parsed as unknown as Record<string, unknown>,
    content: [{ type: 'text', text: opts.text(parsed) }],
  };
}

export function errorResult(opts: { code: string; message: string; recovery?: string }): ToolResult {
  const body = {
    errors: [{ code: opts.code, message: opts.message, recovery: opts.recovery }],
    context: { correlation_id: crypto.randomUUID() },
  };
  return {
    structuredContent: body,
    content: [{ type: 'text', text: `Error (${opts.code}): ${opts.message}${opts.recovery ? ` — ${opts.recovery}` : ''}` }],
    isError: true,
  };
}

/* ─────────────────  Number formatting helpers for summaries  ─────────── */

export function fmtNum(n: number | null | undefined, opts: { digits?: number } = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const digits = opts.digits ?? 0;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

export function fmtPct(n: number | null | undefined, opts: { fromFraction?: boolean } = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const v = opts.fromFraction ? n * 100 : n;
  return `${v.toFixed(2)}%`;
}
