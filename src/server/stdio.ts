import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { DataClient } from '../data-client.js';
import { tools, handleToolCall } from '../tools/index.js';
import { toErrorEnvelope } from '../adcp/error-envelope.js';
import type { CapabilitiesContext } from '../adcp/capabilities.js';

export interface StdioServerOptions {
  dataClient: DataClient;
  agent: { id: string; name: string; version: string };
}

export async function startStdioServer(opts: StdioServerOptions): Promise<void> {
  const capabilitiesContext: CapabilitiesContext = {
    agentId: opts.agent.id,
    agentName: opts.agent.name,
    agentVersion: opts.agent.version,
    toolNames: tools.map((t) => t.name),
    transports: ['stdio'],
  };

  const server = new Server(
    { name: opts.agent.id, version: opts.agent.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
