import { Type } from '@mariozechner/pi-ai';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { writeJsonOutput } from '../../lib/write-json-output.js';

interface WriteJsonOutputParams {
  outputType: 'describe_output' | 'review_output';
  payload: unknown;
  pretty?: boolean;
  indent?: number;
}

export function createWriteJsonOutputTool(workingDir?: string): ToolDefinition {
  return {
    name: 'write_json_output',
    label: 'Write JSON Output',
    description: 'Write validated JSON output for DRS agents.',
    parameters: Type.Object({
      outputType: Type.Union([Type.Literal('describe_output'), Type.Literal('review_output')]),
      payload: Type.Any({ description: 'JSON value or JSON string to write' }),
      pretty: Type.Optional(Type.Boolean({ description: 'Pretty-print JSON output' })),
      indent: Type.Optional(
        Type.Number({ description: 'Indent size when pretty-printing', minimum: 2, maximum: 8 })
      ),
    }) as any,
    execute: async (
      _toolCallId: string,
      params: WriteJsonOutputParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown
    ) => {
      const pointer = await writeJsonOutput({
        outputType: params.outputType,
        payload: params.payload,
        pretty: params.pretty,
        indent: params.indent,
        workingDir,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(pointer) }],
        details: {},
      };
    },
  };
}
