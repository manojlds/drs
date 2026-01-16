import { tool } from '@opencode-ai/plugin';
import { writeJsonOutput } from '../../src/lib/write-json-output.js';

export default tool({
  description: 'Write validated JSON output for DRS agents.',
  args: {
    outputType: tool.schema
      .enum(['describe_output', 'review_output'])
      .describe('The DRS output type to validate and write'),
    payload: tool.schema.any().describe('JSON value or JSON string to write'),
    pretty: tool.schema.boolean().optional().describe('Pretty-print JSON output'),
    indent: tool.schema
      .number()
      .int()
      .min(2)
      .max(8)
      .optional()
      .describe('Indent size when pretty-printing'),
  },
  async execute({ outputType, payload, pretty, indent }) {
    const pointer = await writeJsonOutput({ outputType, payload, pretty, indent });
    return JSON.stringify(pointer);
  },
});
