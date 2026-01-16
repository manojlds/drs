import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { OUTPUT_PATHS, type OutputType } from './output-paths.js';

const JSON_FENCE_REGEX = /```json\s*([\s\S]*?)\s*```/i;

interface DescribeOutputPointer {
  outputType?: OutputType;
  outputPath?: string;
}

function isOutputPointer(value: unknown): value is DescribeOutputPointer {
  return !!value && typeof value === 'object' && ('outputType' in value || 'outputPath' in value);
}

const DESCRIBE_OUTPUT_PATH = OUTPUT_PATHS.describe_output;

function resolveWithinWorkingDir(workingDir: string, targetPath: string): string {
  const root = resolve(workingDir);
  const fullPath = resolve(workingDir, targetPath);
  const rootWithSlash = root.endsWith('/') ? root : `${root}/`;

  if (fullPath !== root && !fullPath.startsWith(rootWithSlash)) {
    throw new Error(`Refusing to read outside working directory: ${targetPath}`);
  }

  return fullPath;
}

async function readJsonIfExists(workingDir: string, targetPath: string): Promise<unknown | null> {
  const resolvedPath = resolveWithinWorkingDir(workingDir, targetPath);
  try {
    const fileContents = await readFile(resolvedPath, 'utf-8');
    return JSON.parse(fileContents);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function resolveDescribeOutputPath(pointer: DescribeOutputPointer | null): string | null {
  if (!pointer) {
    return null;
  }

  if (pointer.outputType && pointer.outputType !== 'describe_output') {
    throw new Error(`Unexpected output type for describe output: ${pointer.outputType}`);
  }

  if (pointer.outputPath) {
    return pointer.outputPath;
  }

  if (pointer.outputType) {
    return OUTPUT_PATHS[pointer.outputType];
  }

  return null;
}

function parseDescribeOutputPointer(
  raw: string,
  debug: boolean
): DescribeOutputPointer | null {
  try {
    const parsed = parseJsonFromAgentOutput(raw);
    if (isOutputPointer(parsed)) {
      return parsed;
    }
    if (debug) {
      console.log('Describe output pointer not found in agent output.');
    }
  } catch (error) {
    if (debug) {
      console.log(
        `Describe output pointer parse failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return null;
}

function findJsonCandidates(text: string): string[] {
  const candidates: string[] = [];

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\') {
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = false;
        }

        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        depth += 1;
        continue;
      }

      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }

  return candidates;
}

export function parseJsonFromAgentOutput(raw: string): unknown {
  const errors: unknown[] = [];

  const fencedMatch = raw.match(JSON_FENCE_REGEX);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1]);
    } catch (error) {
      errors.push(error);
    }
  }

  const candidates = findJsonCandidates(raw);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(candidates[index]);
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    errors.push(error);
  }

  const lastError = errors[errors.length - 1];
  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error('Failed to parse JSON output');
}

export async function parseDescribeOutput(
  workingDir: string = process.cwd(),
  debug = false,
  rawOutput?: string
): Promise<unknown> {
  const pointer = rawOutput ? parseDescribeOutputPointer(rawOutput, debug) : null;
  const pointerPath = resolveDescribeOutputPath(pointer);

  if (pointerPath) {
    const pointerOutput = await readJsonIfExists(workingDir, pointerPath);
    if (pointerOutput) {
      if (debug) {
        console.log(`Describe output loaded from ${pointerPath}`);
      }
      return pointerOutput;
    }
    if (debug) {
      console.log(`Describe output not found at ${pointerPath}, falling back to default path.`);
    }
  }

  const defaultOutput = await readJsonIfExists(workingDir, DESCRIBE_OUTPUT_PATH);
  if (defaultOutput) {
    if (debug) {
      console.log(`Describe output loaded from ${DESCRIBE_OUTPUT_PATH}`);
    }
    return defaultOutput;
  }

  throw new Error(`Describe output file not found at ${DESCRIBE_OUTPUT_PATH}`);
}
