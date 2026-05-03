import { startStdioServer, type StdioServerOptions } from './server/stdio.js';
import { startHttpServer, type HttpServerOptions, type RunningHttpServer } from './server/http.js';

export type {
  DataClient,
  DeliveryQuery,
  DeliveryDimension,
} from './data-client.js';

export type {
  AdCPConfig,
  MediaBuy,
  DeliveryReport,
  GovernanceResult,
  GovernanceViolation,
  InventoryProduct,
  AuditLogEntry,
  AdCPError,
  DeliveryRow,
} from './adcp/types.js';

export { AdCPBuyerClient } from './adcp/buyer-client.js';
export { CacheScheduler } from './cache/scheduler.js';
export { ReportCache, TTL, deliveryTTL } from './cache/store.js';
export { tools } from './tools/index.js';
export { buildCapabilities } from './adcp/capabilities.js';
export { toErrorEnvelope } from './adcp/error-envelope.js';
export type { AdCPErrorBody, AdCPErrorCode } from './adcp/error-envelope.js';

export type { StdioServerOptions, HttpServerOptions, RunningHttpServer };

export type CreatePublisherAnalyticsServerOptions =
  | (StdioServerOptions & { transport: 'stdio' })
  | (HttpServerOptions & { transport: 'http' });

/**
 * Start a publisher analytics agent.
 *
 * Stdio transport returns once the connection is established (typical for Claude Desktop).
 * HTTP transport returns a `RunningHttpServer` handle for graceful shutdown.
 */
export async function createPublisherAnalyticsServer(
  opts: CreatePublisherAnalyticsServerOptions,
): Promise<RunningHttpServer | void> {
  if (opts.transport === 'http') {
    return startHttpServer(opts);
  }
  return startStdioServer(opts);
}
