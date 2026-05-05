import {
  visualizationRequestSchema,
  visualizationResponseSchema,
  type VisualizationRequest,
} from '../extension/schemas.js';
import { structured, errorResult } from '../extension/tool-result.js';

export const visualizationSchema = visualizationRequestSchema;

export const visualizationTool = {
  name: 'generate_visualization',
  description: `Produce a chart spec from data returned by another tool. NOT part of the AdCP data surface — this is a UI-rendering helper.
Call a data tool first (get_delivery_summary, get_morning_briefing, etc.), then pass its data here.
Supported chart types: line (trends over time), bar (comparisons), area (cumulative), pie (share/mix).`,
  inputSchema: {
    type: 'object' as const,
    required: ['chartType', 'title', 'data', 'xKey', 'series'],
    properties: {
      chartType: { type: 'string', enum: ['line', 'bar', 'area', 'pie'] },
      title: { type: 'string' },
      description: { type: 'string' },
      data: { type: 'string', description: 'JSON-encoded array of records' },
      xKey: { type: 'string' },
      series: {
        type: 'array',
        items: {
          type: 'object',
          required: ['key', 'label'],
          properties: { key: { type: 'string' }, label: { type: 'string' }, color: { type: 'string' } },
        },
      },
    },
  },
};

export function handleGenerateVisualization(args: VisualizationRequest) {
  let parsedData: unknown;
  try {
    parsedData = JSON.parse(args.data);
  } catch {
    return errorResult({ code: 'VALIDATION_ERROR', message: 'data must be a valid JSON array', recovery: 'Pass the raw JSON array string from a previous tool result' });
  }
  if (!Array.isArray(parsedData)) {
    return errorResult({ code: 'VALIDATION_ERROR', message: 'data must decode to a JSON array' });
  }

  return structured({
    schema: visualizationResponseSchema,
    data: {
      __type: 'adcp_chart' as const,
      chart_type: args.chartType,
      title: args.title,
      description: args.description,
      data: parsedData as Record<string, unknown>[],
      x_key: args.xKey,
      series: args.series,
    },
    text: () => `Chart spec ready: ${args.chartType} "${args.title}" (${(parsedData as unknown[]).length} data points).`,
  });
}
