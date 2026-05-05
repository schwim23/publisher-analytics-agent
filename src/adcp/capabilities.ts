/**
 * `getAdcpCapabilities` — required tool for any AdCP-conformant agent.
 *
 * Important framing: this agent does NOT implement any standard AdCP 3.0
 * specialism. There is no `analytics` protocol or `publisher-analytics`
 * specialism in the spec yet. The publisher-analytics surface lives entirely
 * inside the `extensions["x-publisher-analytics"]` vendor block, declared as
 * `status: "experimental"` so buyers don't mistake it for ratified spec.
 *
 * The discovery flow for buyers is:
 *   1. call `get_adcp_capabilities`
 *   2. check `extensions["x-publisher-analytics"]` is present and non-stale
 *   3. read its `tools` list (analytics surface) and `client_utilities` list
 *      (UI helpers like `generate_visualization`)
 */

import {
  EXTENSION_NAME,
  EXTENSION_VERSION,
  EXTENSION_SCHEMA_VERSION,
} from '../extension/schemas.js';

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

const EXTENSION_LIMITATIONS = [
  'Pre-spec; not part of any ratified AdCP specialism.',
  'Tool argument and response schemas may change before 1.0.',
  'Revenue values mapped from buyer spend are estimates, not publisher-net revenue.',
  'Backends without ad-request or fill data will return `null` for those metrics; tools degrade gracefully but lose precision.',
  'No formal storyboard suite exists for this extension yet — conformance is by review only.',
];

export interface CapabilitiesContext {
  agentId: string;
  agentName: string;
  agentVersion: string;
  toolNames: string[];
  transports: Array<'stdio' | 'http'>;
}

export const capabilitiesTool = {
  name: 'get_adcp_capabilities',
  description: 'Return this agent\'s AdCP capability envelope: AdCP version + idempotency, supported protocols and specialisms (none, by design), supported transports, and any vendor extensions. Required for AdCP-conformant agents.',
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
    // No standard AdCP protocols or specialisms — see extension below.
    supported_protocols: [] as string[],
    specialisms: [] as string[],
    extensions: {
      [EXTENSION_NAME]: {
        version: EXTENSION_VERSION,
        schema_version: EXTENSION_SCHEMA_VERSION,
        status: 'experimental',
        rfc: RFC_URL,
        description:
          'Publisher-side aggregate analytics surface — yield, pacing, inventory forecast, multi-period comparison, anomaly detection. NOT an AdCP specialism; this is a vendor extension proposal.',
        tools: tools.filter((n) => ANALYTICS_TOOLS.has(n)),
        client_utilities: tools.filter((n) => CONSUMER_UTILITIES.has(n)),
        limitations: EXTENSION_LIMITATIONS,
      },
    },
    request_signing: { supported: false },
    transports: ctx.transports,
  };
}

export function handleGetAdcpCapabilities(ctx: CapabilitiesContext) {
  const data = buildCapabilities(ctx);
  return {
    structuredContent: data as unknown as Record<string, unknown>,
    content: [{
      type: 'text' as const,
      text: `${ctx.agentName} v${ctx.agentVersion} — AdCP 3.0 envelope, no standard specialisms. Experimental extension '${EXTENSION_NAME}' v${EXTENSION_VERSION} exposes ${data.extensions[EXTENSION_NAME].tools.length} analytics tool(s).`,
    }],
  };
}
