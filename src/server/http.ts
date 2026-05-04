import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { DataClient } from '../data-client.js';
import { tools, handleToolCall } from '../tools/index.js';
import { toErrorEnvelope } from '../adcp/error-envelope.js';
import type { CapabilitiesContext } from '../adcp/capabilities.js';

export interface HttpServerOptions {
  dataClient: DataClient;
  agent: { id: string; name: string; version: string };
  port?: number;
  host?: string;
  /** Bearer token required in `x-adcp-auth` header. If unset, no auth check (LOCAL DEV ONLY). */
  bearerToken?: string;
  /** JSON content for `GET /.well-known/adagents.json` (publisher's authorized-agents list). */
  wellKnownAdagents?: unknown;
  /** JSON content for `GET /.well-known/brand.json` (this brand's named agents). */
  wellKnownBrand?: unknown;
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

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      return await handleToolCall(opts.dataClient, capabilitiesContext, name, args as Record<string, unknown>);
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
    const header = req.headers['x-adcp-auth'];
    const presented = Array.isArray(header) ? header[0] : header;
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
        message: 'Missing or invalid x-adcp-auth header',
        recovery: 'Provide a valid Bearer token via the x-adcp-auth header',
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
