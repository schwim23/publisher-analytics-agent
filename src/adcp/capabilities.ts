/**
 * `getAdcpCapabilities` — required tool for any AdCP-conformant agent.
 *
 * The AdCP 3.0 spec doesn't yet define an `analytics` protocol or a `publisher-analytics`
 * specialism. While a [forthcoming RFC](https://github.com/adcontextprotocol/adcp/issues)
 * debates ratifying the agent type, this agent declares no `supported_protocols` and
 * exposes its analytics surface via the `x-publisher-analytics` vendor extension. The
 * extension is the discovery signal for buyers; declaring a stand-in protocol like
 * `governance` would falsely imply we implement that protocol's tools.
 *
 * Visualizations are tracked separately as a consumer-side utility — they're a UI
 * affordance, not part of the AdCP data surface.
 */

const RFC_URL = 'https://github.com/adcontextprotocol/adcp/issues';

const ANALYTICS_TOOLS = new Set([
  'get_delivery_summary',
  'get_pacing_alerts',
  'get_morning_briefing',
  'get_yield_anomalies',
  'get_inventory_forecast',
  'compare_periods',
  'get_plan_audit_logs',
]);

const CONSUMER_UTILITIES = new Set([
  'generate_visualization',
]);

export interface CapabilitiesContext {
  agentId: string;
  agentName: string;
  agentVersion: string;
  toolNames: string[];
  transports: Array<'stdio' | 'http'>;
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
  const tools = ctx.toolNames.filter((n) => n !== 'get_adcp_capabilities');
  return {
    adcp: {
      major_versions: [3],
      idempotency: { supported: false },
    },
    agent: {
      id: ctx.agentId,
      name: ctx.agentName,
      version: ctx.agentVersion,
    },
    supported_protocols: [] as string[],
    specialisms: [] as string[],
    extensions: {
      'x-publisher-analytics': {
        version: '0.1.0',
        rfc: RFC_URL,
        description: 'Publisher-side aggregate analytics: yield, pacing, inventory forecast, multi-period comparison, anomaly detection. Pre-spec preview.',
        tools: tools.filter((n) => ANALYTICS_TOOLS.has(n)),
        client_utilities: tools.filter((n) => CONSUMER_UTILITIES.has(n)),
      },
    },
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
