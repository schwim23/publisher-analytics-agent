import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { DataClient } from '../data-client.js';
import { tools, handleToolCall } from '../tools/index.js';
import { toErrorEnvelope } from '../adcp/error-envelope.js';
import type { CapabilitiesContext } from '../adcp/capabilities.js';
import { ALL_SCOPES, DEV_BYPASS_CONTEXT, type AuthContext, type Scope } from '../extension/auth.js';

export interface HttpServerOptions {
  dataClient: DataClient;
  agent: { id: string; name: string; version: string };
  port?: number;
  host?: string;
  /** Bearer token required in the standard `Authorization: Bearer <token>` header. If unset, no auth check (LOCAL DEV ONLY). */
  bearerToken?: string;
  /** JSON content for `GET /.well-known/adagents.json` (publisher's authorized-agents list). */
  wellKnownAdagents?: unknown;
  /** JSON content for `GET /.well-known/brand.json` (this brand's named agents). */
  wellKnownBrand?: unknown;
  /**
   * Scopes granted to authenticated callers. Defaults to ALL_SCOPES when a
   * bearer token is set (single-tenant mode), or `[]` when no token is set
   * (in which case the server runs in dev-bypass mode and this field is
   * ignored). Multi-tenant deployments should compose their own per-token
   * scope mapping at a layer above this server.
   */
  bearerScopes?: ReadonlyArray<Scope>;
  /** Optional tenant id stamped onto audit-log events for bearer-mode calls. */
  tenantId?: string;
}

export interface RunningHttpServer {
  close(): Promise<void>;
  port: number;
}

export async function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const port = opts.port ?? 7000;
  const host = opts.host ?? '127.0.0.1';

  const capabilitiesContext: CapabilitiesContext = {
    agentId: opts.agent.id,
    agentName: opts.agent.name,
    agentVersion: opts.agent.version,
    toolNames: tools.map((t) => t.name),
    transports: ['http'],
  };

  const mcpServer = new Server(
    { name: opts.agent.id, version: opts.agent.version },
    { capabilities: { tools: {} } },
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  // Single-tenant bearer-mode AuthContext. The HTTP layer (below) rejects
  // unauthorized requests with a 401 before they ever reach this handler;
  // any request that gets here is authenticated. Multi-tenant deployments
  // should swap this for an AsyncLocalStorage-backed context per request.
  const bearerAuthContext: AuthContext = {
    mode: 'bearer',
    tenant_id: opts.tenantId,
    caller_id: 'bearer',
    scopes: opts.bearerScopes ?? ALL_SCOPES,
  };
  const activeAuthContext: AuthContext = opts.bearerToken ? bearerAuthContext : DEV_BYPASS_CONTEXT;

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      return await handleToolCall(opts.dataClient, capabilitiesContext, activeAuthContext, name, args as Record<string, unknown>);
    } catch (err) {
      const env = toErrorEnvelope(err);
      return {
        content: [{ type: 'text', text: JSON.stringify(env.body) }],
        isError: env.isError,
      };
    }
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcpServer.connect(transport);

  function isAuthorized(req: IncomingMessage): boolean {
    if (!opts.bearerToken) return true;
    // AdCP 3.0 uses standard `Authorization: Bearer <token>`.
    const raw = req.headers['authorization'];
    const presented = Array.isArray(raw) ? raw[0] : raw;
    if (!presented) return false;
    const token = presented.startsWith('Bearer ') ? presented.slice(7) : presented;
    return token === opts.bearerToken;
  }

  function writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function writeUnauthorized(res: ServerResponse): void {
    writeJson(res, 401, {
      errors: [{
        code: 'AUTH_REQUIRED',
        message: 'Missing or invalid Authorization header',
        recovery: 'Provide a valid Bearer token via the Authorization header (e.g. `Authorization: Bearer <token>`)',
      }],
      context: { correlation_id: crypto.randomUUID() },
    });
  }

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];

    if (req.method === 'GET' && pathname === '/.well-known/adagents.json') {
      if (opts.wellKnownAdagents === undefined) return writeJson(res, 404, { error: 'Not configured' });
      return writeJson(res, 200, opts.wellKnownAdagents);
    }

    if (req.method === 'GET' && pathname === '/.well-known/brand.json') {
      if (opts.wellKnownBrand === undefined) return writeJson(res, 404, { error: 'Not configured' });
      return writeJson(res, 200, opts.wellKnownBrand);
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      return writeJson(res, 200, { ok: true, agent: opts.agent });
    }

    if ((req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE') && (pathname === '/mcp' || pathname === '/mcp/')) {
      if (!isAuthorized(req)) return writeUnauthorized(res);
      try {
        await transport.handleRequest(req, res);
      } catch (err) {
        if (!res.headersSent) {
          writeJson(res, 500, {
            errors: [{ code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) }],
            context: { correlation_id: crypto.randomUUID() },
          });
        }
      }
      return;
    }

    writeJson(res, 404, { error: 'Not found' });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await transport.close();
    },
  };
}
