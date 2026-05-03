/**
 * AdCP-canonical error envelope.
 *
 * Per the AdCP "build-seller-agent" guidance, errors follow a uniform `errors[]` + `context.correlation_id`
 * shape, and codes use a small canonical set so clients can branch on them programmatically. Notably,
 * `REFERENCE_NOT_FOUND` is used for both missing and forbidden resources (resolve-then-authorize) to
 * prevent tenant enumeration via 404-vs-403 timing differences.
 */

export type AdCPErrorCode =
  | 'AUTH_REQUIRED'
  | 'REFERENCE_NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface AdCPErrorBody {
  errors: Array<{
    code: AdCPErrorCode | string;
    message: string;
    recovery?: string;
  }>;
  context: {
    correlation_id: string;
  };
}

export function toErrorEnvelope(err: unknown): { body: AdCPErrorBody; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  const code = inferCodeFromMessage(message);
  return {
    body: {
      errors: [{
        code,
        message,
        recovery: recoveryFor(code),
      }],
      context: { correlation_id: crypto.randomUUID() },
    },
    isError: true,
  };
}

function inferCodeFromMessage(message: string): AdCPErrorCode {
  if (/^AdCP 401\b|\bunauthor/i.test(message)) return 'AUTH_REQUIRED';
  if (/^AdCP 403\b|\bforbidden/i.test(message)) return 'REFERENCE_NOT_FOUND';
  if (/^AdCP 404\b|\bnot found/i.test(message)) return 'REFERENCE_NOT_FOUND';
  if (/^AdCP 429\b|\brate.?limit/i.test(message)) return 'RATE_LIMITED';
  if (/\bvalidation|invalid (input|argument)/i.test(message)) return 'VALIDATION_ERROR';
  return 'INTERNAL_ERROR';
}

function recoveryFor(code: AdCPErrorCode): string {
  switch (code) {
    case 'AUTH_REQUIRED': return 'Provide a valid Bearer token via the x-adcp-auth header';
    case 'REFERENCE_NOT_FOUND': return 'Verify the resource ID exists and the caller is authorized for it';
    case 'VALIDATION_ERROR': return 'Check the request payload against the tool input schema';
    case 'RATE_LIMITED': return 'Retry after backoff';
    case 'INTERNAL_ERROR': return 'Check server logs and the correlation_id';
  }
}
