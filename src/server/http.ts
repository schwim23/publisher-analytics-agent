import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { DataClient } from '../data-client.js';
import { tools, handleToolCall } from '../tools/index.js';
import { toErrorEnvelope } from '../adcp/error-envelope.js';
import type { CapabilitiesContext } from '../adcp/capabilities.js';
import { ALL_SCOPES, DEV_BYPASS_CONTEXT, authContextStore, type AuthContext, type Scope } from '../extension/auth.js';

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

  // Default fallback context — used by stdio-style direct dispatch and as the
  // baseline when HTTP requests have no bound ALS store. The HTTP layer below
  // rebuilds an AuthContext per request and runs the MCP transport inside
  // `authContextStore.run(...)`, so the dispatch picks up the per-request
  // identity via `currentAuthContext()` rather than this fallback.
  const fallbackAuthContext: AuthContext = opts.bearerToken
    ? { mode: 'bearer', tenant_id: opts.tenantId, caller_id: 'bearer', scopes: opts.bearerScopes ?? ALL_SCOPES }
    : DEV_BYPASS_CONTEXT;

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      // handleToolCall internally prefers the ALS-stored AuthContext. The
      // explicit fallback only kicks in when no ALS store is bound (e.g.
      // direct programmatic invocation outside the HTTP transport).
      return await handleToolCall(opts.dataClient, capabilitiesContext, fallbackAuthContext, name, args as Record<string, unknown>);
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

  function extractBearer(req: IncomingMessage): string | null {
    const raw = req.headers['authorization'];
    const presented = Array.isArray(raw) ? raw[0] : raw;
    if (!presented) return null;
    return presented.startsWith('Bearer ') ? presented.slice(7) : presented;
  }

  function isAuthorized(req: IncomingMessage): boolean {
    if (!opts.bearerToken) return true;
    // AdCP 3.0 uses standard `Authorization: Bearer <token>`.
    const token = extractBearer(req);
    return token !== null && token === opts.bearerToken;
  }

  function buildPerRequestAuthContext(req: IncomingMessage): AuthContext {
    if (!opts.bearerToken) return DEV_BYPASS_CONTEXT;
    const token = extractBearer(req);
    return {
      mode: 'bearer',
      tenant_id: opts.tenantId,
      // Use the (rough) token-fingerprint as caller_id so the audit log can
      // distinguish callers with different tokens without leaking the token
      // itself. Multi-tenant deployments should swap this for a real lookup.
      caller_id: token ? `bearer:${token.slice(0, 6)}` : 'bearer',
      scopes: opts.bearerScopes ?? ALL_SCOPES,
    };
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
      const perRequestCtx = buildPerRequestAuthContext(req);
      try {
        // Run the MCP transport inside the ALS store so any tool dispatched
        // by this request sees the per-request AuthContext via
        // `currentAuthContext()` — including caller_id (bearer fingerprint),
        // tenant_id, and scopes.
        await authContextStore.run(perRequestCtx, () => transport.handleRequest(req, res));
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
