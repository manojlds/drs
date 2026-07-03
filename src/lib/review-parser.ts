import { readFile } from 'fs/promises';
import { resolveWithinWorkingDir } from './path-utils.js';
import { parseJsonFromAgentOutput } from './describe-parser.js';
import {
  loadLatestReviewArtifact,
  reviewArtifactToJsonOutput,
  toRepoRelativePath,
} from './review-artifact-store.js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface ReviewOutputPointer {
  outputType?: string;
  outputPath?: string;
}

function isOutputPointer(value: unknown): value is ReviewOutputPointer {
  return !!value && typeof value === 'object' && ('outputType' in value || 'outputPath' in value);
}

async function readJsonIfExists(workingDir: string, targetPath: string): Promise<JsonValue | null> {
  const resolvedPath = resolveWithinWorkingDir(workingDir, targetPath, 'read');
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

  if (pointer.outputType) {
    throw new Error(`Unexpected output type for review output: ${pointer.outputType}`);
  }

  if (pointer.outputPath) {
    return pointer.outputPath;
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
      console.log(`Review output not found at ${pointerPath}.`);
    }
  }

  const latestReviewArtifact = await loadLatestReviewArtifact(workingDir);
  if (latestReviewArtifact) {
    const artifactPath = toRepoRelativePath(workingDir, latestReviewArtifact.path);
    if (debug) {
      console.log(`Review output loaded from ${artifactPath}`);
    }
    return {
      ...reviewArtifactToJsonOutput(latestReviewArtifact.artifact.payload),
      artifact: {
        reviewId: latestReviewArtifact.artifact.payload.reviewId,
        path: artifactPath,
      },
    };
  }

  throw new Error('Review output not found in raw output or canonical review artifacts.');
}
