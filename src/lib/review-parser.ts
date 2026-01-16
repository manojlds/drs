import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { OUTPUT_PATHS, type OutputType } from './output-paths.js';
import { parseJsonFromAgentOutput } from './describe-parser.js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface ReviewOutputPointer {
  outputType?: OutputType;
  outputPath?: string;
}

function isOutputPointer(value: unknown): value is ReviewOutputPointer {
  return !!value && typeof value === 'object' && ('outputType' in value || 'outputPath' in value);
}

const REVIEW_OUTPUT_PATH = OUTPUT_PATHS.review_output;

function resolveWithinWorkingDir(workingDir: string, targetPath: string): string {
  const root = resolve(workingDir);
  const fullPath = resolve(workingDir, targetPath);
  const rootWithSlash = root.endsWith('/') ? root : `${root}/`;

  if (fullPath !== root && !fullPath.startsWith(rootWithSlash)) {
    throw new Error(`Refusing to read outside working directory: ${targetPath}`);
  }

  return fullPath;
}

async function readJsonIfExists(workingDir: string, targetPath: string): Promise<JsonValue | null> {
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

function resolveReviewOutputPath(pointer: ReviewOutputPointer | null): string | null {
  if (!pointer) {
    return null;
  }

  if (pointer.outputType && pointer.outputType !== 'review_output') {
    throw new Error(`Unexpected output type for review output: ${pointer.outputType}`);
  }

  if (pointer.outputPath) {
    return pointer.outputPath;
  }

  if (pointer.outputType) {
    return OUTPUT_PATHS[pointer.outputType];
  }

  return null;
}

function parseReviewOutputPointer(raw: string, debug: boolean): ReviewOutputPointer | null {
  try {
    const parsed = parseJsonFromAgentOutput(raw);
    if (isOutputPointer(parsed)) {
      return parsed;
    }
    if (debug) {
      console.log('Review output pointer not found in agent output.');
    }
  } catch (error) {
    if (debug) {
      console.log(
        `Review output pointer parse failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return null;
}

export async function parseReviewOutput(
  workingDir: string = process.cwd(),
  debug = false,
  rawOutput?: string
): Promise<unknown> {
  if (rawOutput) {
    try {
      const parsed = parseJsonFromAgentOutput(rawOutput);
      if (parsed && !isOutputPointer(parsed)) {
        return parsed;
      }
    } catch (error) {
      if (debug) {
        console.log(
          `Review output JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  const pointer = rawOutput ? parseReviewOutputPointer(rawOutput, debug) : null;
  const pointerPath = resolveReviewOutputPath(pointer);

  if (pointerPath) {
    const pointerOutput = await readJsonIfExists(workingDir, pointerPath);
    if (pointerOutput) {
      if (debug) {
        console.log(`Review output loaded from ${pointerPath}`);
      }
      return pointerOutput;
    }
    if (debug) {
      console.log(`Review output not found at ${pointerPath}, falling back to default path.`);
    }
  }

  const defaultOutput = await readJsonIfExists(workingDir, REVIEW_OUTPUT_PATH);
  if (defaultOutput) {
    if (debug) {
      console.log(`Review output loaded from ${REVIEW_OUTPUT_PATH}`);
    }
    return defaultOutput;
  }

  throw new Error(`Review output file not found at ${REVIEW_OUTPUT_PATH}`);
}
