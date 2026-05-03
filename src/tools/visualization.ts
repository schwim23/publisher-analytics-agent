import { z } from 'zod';

const seriesSchema = z.object({
  key: z.string().describe('Data field name'),
  label: z.string().describe('Human-readable series label'),
  color: z.string().optional().describe('Hex color (optional, UI will assign defaults)'),
});

export const visualizationSchema = z.object({
  chartType: z.enum(['line', 'bar', 'area', 'pie']).describe('Chart type'),
  title: z.string().describe('Chart title'),
  description: z.string().optional().describe('Optional subtitle or annotation'),
  data: z.string().describe('JSON array of data objects (copy from a previous tool result)'),
  xKey: z.string().describe('Field name to use for the x-axis or pie labels'),
  series: z.array(seriesSchema).min(1).describe('One entry per metric to plot'),
});

export const visualizationTool = {
  name: 'generate_visualization',
  description: `Produce a chart spec from data returned by another tool.
Call a data tool first (get_delivery_summary, get_morning_briefing, etc.),
then pass its data here to generate a visualization the UI will render inline.
Supported chart types: line (trends over time), bar (comparisons), area (cumulative), pie (share/mix).`,
  inputSchema: {
    type: 'object' as const,
    required: ['chartType', 'title', 'data', 'xKey', 'series'],
    properties: {
      chartType: { type: 'string', enum: ['line', 'bar', 'area', 'pie'], description: 'Chart type' },
      title: { type: 'string', description: 'Chart title' },
      description: { type: 'string', description: 'Optional subtitle or annotation' },
      data: { type: 'string', description: 'JSON array of data objects' },
      xKey: { type: 'string', description: 'Field name for x-axis or pie labels' },
      series: {
        type: 'array',
        items: {
          type: 'object',
          required: ['key', 'label'],
          properties: {
            key: { type: 'string' },
            label: { type: 'string' },
            color: { type: 'string' },
          },
        },
        description: 'Metrics to plot',
      },
    },
  },
};

export function handleGenerateVisualization(args: z.infer<typeof visualizationSchema>) {
  let data: unknown;
  try {
    data = JSON.parse(args.data);
  } catch {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          errors: [{ code: 'INVALID_INPUT', message: 'data must be a valid JSON array', recovery: 'Pass the raw JSON array string from a previous tool result' }],
          context: { correlation_id: crypto.randomUUID() },
        }),
      }],
      isError: true,
    };
  }

  const spec = {
    __type: 'adcp_chart',
    chartType: args.chartType,
    title: args.title,
    description: args.description,
    data,
    xKey: args.xKey,
    series: args.series,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(spec) }],
  };
}
