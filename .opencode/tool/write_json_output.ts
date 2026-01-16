import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { tool } from '@opencode-ai/plugin';
import Ajv from 'ajv';
import { describeOutputSchema, reviewOutputSchema } from '../../src/lib/json-output-schema.js';
import { OUTPUT_PATHS } from '../../src/lib/output-paths.js';

const DEFAULT_INDENT = 2;

const ajv = new Ajv({ allErrors: true });

function resolveWithinWorkingDir(targetPath: string): string {
  const root = resolve(process.cwd());
  const fullPath = resolve(process.cwd(), targetPath);
  const rootWithSlash = root.endsWith('/') ? root : `${root}/`;

  if (fullPath !== root && !fullPath.startsWith(rootWithSlash)) {
    throw new Error(`Refusing to write outside working directory: ${targetPath}`);
  }

  return fullPath;
}

const validateDescribeOutput = ajv.compile(describeOutputSchema);
const validateReviewOutput = ajv.compile(reviewOutputSchema);

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
    const jsonValue = typeof payload === 'string' ? JSON.parse(payload) : payload;

    const isValid =
      outputType === 'describe_output'
        ? validateDescribeOutput(jsonValue)
        : validateReviewOutput(jsonValue);

    if (!isValid) {
      const errorText = ajv.errorsText(
        outputType === 'describe_output'
          ? validateDescribeOutput.errors
          : validateReviewOutput.errors,
        { separator: '\n' }
      );
      throw new Error(`Output validation failed:\n${errorText}`);
    }

    const spacing = pretty === false ? null : indent ?? DEFAULT_INDENT;
    const jsonContent = JSON.stringify(jsonValue, null, spacing);
    const resolvedPath = resolveWithinWorkingDir(OUTPUT_PATHS[outputType]);
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, jsonContent, 'utf-8');

    return JSON.stringify({ outputType, outputPath: OUTPUT_PATHS[outputType] });
  },
});
