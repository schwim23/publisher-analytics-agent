/**
 * `getAdcpCapabilities` — required tool for any AdCP-conformant agent.
 *
 * Until the AdCP spec ratifies a top-level `analytics` protocol with a `publisher-analytics`
 * specialism (see RFC issue at https://github.com/adcontextprotocol/adcp/issues), this agent
 * declares a placeholder `governance` protocol membership and exposes its analytics surface
 * via the `x-publisher-analytics` vendor extension. The same pattern was used by issue #3612
 * for measurement-verification before its specialism was promoted.
 */

const ADCP_VERSION = '3.0';
const RFC_URL = 'https://github.com/adcontextprotocol/adcp/issues';

export interface CapabilitiesContext {
  agentId: string;
  agentName: string;
  agentVersion: string;
  toolNames: string[];
  transports: Array<'stdio' | 'http'>;
  channels?: string[];
}

export const capabilitiesTool = {
  name: 'get_adcp_capabilities',
  description: 'Return this agent\'s AdCP capability envelope: protocol/specialism membership, supported tools, transports, and any vendor extensions. Required for AdCP-conformant agents.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

export function buildCapabilities(ctx: CapabilitiesContext) {
  const analyticsTools = ctx.toolNames.filter((n) => n !== 'get_adcp_capabilities');
  return {
    adcp_version: ADCP_VERSION,
    agent: {
      id: ctx.agentId,
      name: ctx.agentName,
      version: ctx.agentVersion,
    },
    supported_protocols: ['governance'],
    specialisms: [] as string[],
    extensions: {
      'x-publisher-analytics': {
        version: '0.1.0',
        rfc: RFC_URL,
        description: 'Publisher-side aggregate analytics: yield, pacing, inventory forecast, multi-period comparison, anomaly detection. Pre-spec preview.',
        tools: analyticsTools,
      },
    },
    pricing_models: [] as string[],
    channels: ctx.channels ?? ['display', 'video', 'ctv'],
    request_signing: { supported: false },
    transports: ctx.transports,
  };
}

export function handleGetAdcpCapabilities(ctx: CapabilitiesContext) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(buildCapabilities(ctx), null, 2),
    }],
  };
}
