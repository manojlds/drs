import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import Ajv from 'ajv';
import { describeOutputSchema, reviewOutputSchema } from './json-output-schema.js';
import { OUTPUT_PATHS, type OutputType } from './output-paths.js';

const DEFAULT_INDENT = 2;
const ajv = new Ajv({ allErrors: true });

const validateDescribeOutput = ajv.compile(describeOutputSchema);
const validateReviewOutput = ajv.compile(reviewOutputSchema);

function resolveWithinWorkingDir(workingDir: string, targetPath: string): string {
  const root = resolve(workingDir);
  const fullPath = resolve(workingDir, targetPath);
  const rootWithSlash = root.endsWith('/') ? root : `${root}/`;

  if (fullPath !== root && !fullPath.startsWith(rootWithSlash)) {
    throw new Error(`Refusing to write outside working directory: ${targetPath}`);
  }

  return fullPath;
}

export interface WriteJsonOutputArgs {
  outputType: OutputType;
  payload: unknown;
  pretty?: boolean;
  indent?: number;
  workingDir?: string;
}

export async function writeJsonOutput({
  outputType,
  payload,
  pretty,
  indent,
  workingDir,
}: WriteJsonOutputArgs): Promise<{ outputType: OutputType; outputPath: string }> {
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

  const spacing = pretty === false ? undefined : (indent ?? DEFAULT_INDENT);
  const jsonContent = JSON.stringify(jsonValue, null, spacing);
  const resolvedPath = resolveWithinWorkingDir(
    workingDir ?? process.env.DRS_PROJECT_ROOT ?? process.cwd(),
    OUTPUT_PATHS[outputType]
  );
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, jsonContent, 'utf-8');

  return { outputType, outputPath: OUTPUT_PATHS[outputType] };
}
