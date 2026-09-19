import type { FileWithDiff } from '../review-core.js';
import { JEV_MODEL, JevClientError } from './client.js';
import type { JevQuestions } from './questions.js';
import type { JevResponse } from './schema.js';
import {
  buildJevReviewState,
  type BuildJevReviewStateOptions,
  type JevReviewState,
} from './review.js';

const REQUEST_BUDGET_RATIO = 0.8;
const TOKEN_ESTIMATE_BYTES_PER_TOKEN = 3;

export interface JevReviewChunk {
  files: FileWithDiff[];
  fileNames: string[];
  coverageOnlyFileNames?: string[];
}

export interface JevChunkEvaluation {
  response: JevResponse;
  fileNames: string[];
  weight: number;
}

export interface EvaluateJevChunksOptions extends Omit<
  BuildJevReviewStateOptions,
  'files' | 'chunk'
> {
  files: FileWithDiff[];
  contextWindow: number;
  questions: JevQuestions;
  evaluate: (state: JevReviewState, questions: JevQuestions) => Promise<JevResponse>;
}

export async function evaluateJevChunks(
  options: EvaluateJevChunksOptions
): Promise<JevChunkEvaluation[]> {
  const missing = options.files
    .filter((file) => file.patch === undefined)
    .map((file) => file.filename);
  if (missing.length > 0) {
    throw new Error(
      `Jev evaluation requires complete patches for every reviewed file. Missing: ${missing.join(', ')}`
    );
  }

  const reviewable = options.files.filter((file) => (file.patch ?? '').trim().length > 0);
  const emptyFileNames = options.files
    .filter((file) => (file.patch ?? '').trim().length === 0)
    .map((file) => file.filename);

  const requestBudget = Math.floor(options.contextWindow * REQUEST_BUDGET_RATIO);
  // Empty patches have no reviewable content, so exclude them from the evaluated payload while
  // still counting them in coverage. If every patch is empty, fall back to a single no-content
  // review so the evaluation does not fail.
  const chunkInputs = reviewable.length > 0 ? reviewable : options.files;
  const chunks = createJevReviewChunks({ ...options, files: chunkInputs }, requestBudget);
  if (reviewable.length > 0 && emptyFileNames.length > 0 && chunks.length > 0) {
    chunks[0].coverageOnlyFileNames = emptyFileNames;
  }

  const completed: JevChunkEvaluation[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    await evaluateWithAdaptiveSplit(options, chunks[index], requestBudget, completed, {
      index,
      total: chunks.length,
    });
  }
  return completed;
}

export function estimateJevRequestTokens(state: JevReviewState, questions: JevQuestions): number {
  const payload = JSON.stringify({ state, model: JEV_MODEL, questions });
  return Math.ceil(Buffer.byteLength(payload, 'utf8') / TOKEN_ESTIMATE_BYTES_PER_TOKEN);
}

function createJevReviewChunks(
  options: EvaluateJevChunksOptions,
  requestBudget: number
): JevReviewChunk[] {
  const units = options.files.flatMap((file) => splitOversizedFile(options, file, requestBudget));
  const chunks: JevReviewChunk[] = [];
  let current: FileWithDiff[] = [];

  for (const unit of units) {
    const candidate = [...current, unit];
    if (current.length > 0 && estimatedTokens(options, candidate) > requestBudget) {
      chunks.push(toChunk(current));
      current = [unit];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(toChunk(current));
  return chunks;
}

function splitOversizedFile(
  options: EvaluateJevChunksOptions,
  file: FileWithDiff,
  requestBudget: number
): FileWithDiff[] {
  if (estimatedTokens(options, [file]) <= requestBudget) return [file];
  const remaining = Array.from(file.patch ?? '');
  const parts: FileWithDiff[] = [];

  while (remaining.length > 0) {
    let low = 1;
    let high = remaining.length;
    let fittingLength = 0;
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const patch = remaining.slice(0, midpoint).join('');
      if (estimatedTokens(options, [{ filename: file.filename, patch }]) <= requestBudget) {
        fittingLength = midpoint;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    if (fittingLength === 0) {
      throw new Error(`Jev request metadata for ${file.filename} exceeds the request budget.`);
    }

    const newline = remaining.slice(0, fittingLength).lastIndexOf('\n');
    const partLength = newline > 0 ? newline + 1 : fittingLength;
    parts.push({ filename: file.filename, patch: remaining.splice(0, partLength).join('') });
  }
  return parts;
}

async function evaluateWithAdaptiveSplit(
  options: EvaluateJevChunksOptions,
  chunk: JevReviewChunk,
  requestBudget: number,
  completed: JevChunkEvaluation[],
  position: { index: number; total: number }
): Promise<void> {
  const state = stateFor(options, chunk.files, position);
  try {
    const response = await options.evaluate(state, options.questions);
    completed.push({
      response,
      fileNames: [...chunk.fileNames, ...(chunk.coverageOnlyFileNames ?? [])],
      weight: Math.max(
        1,
        chunk.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.patch ?? '', 'utf8'), 0)
      ),
    });
  } catch (error) {
    if (!(error instanceof JevClientError) || error.code !== 'token_limit') throw error;
    const halves = splitChunk(chunk);
    if (!halves) {
      throw new Error(
        `Jev rejected the smallest possible chunk for ${chunk.fileNames.join(', ')}.`
      );
    }
    for (const half of halves) {
      if (estimatedTokens(options, half.files) > requestBudget && half.files.length === 1) {
        const splitFiles = splitOversizedFile(options, half.files[0], requestBudget);
        let coverageOnlyFileNames = half.coverageOnlyFileNames;
        for (const file of splitFiles) {
          const chunk = toChunk([file], coverageOnlyFileNames);
          coverageOnlyFileNames = undefined;
          await evaluateWithAdaptiveSplit(options, chunk, requestBudget, completed, position);
        }
      } else {
        await evaluateWithAdaptiveSplit(options, half, requestBudget, completed, position);
      }
    }
  }
}

function splitChunk(chunk: JevReviewChunk): [JevReviewChunk, JevReviewChunk] | undefined {
  const coverageOnlyFileNames = chunk.coverageOnlyFileNames;
  if (chunk.files.length > 1) {
    const midpoint = Math.ceil(chunk.files.length / 2);
    return [
      toChunk(chunk.files.slice(0, midpoint), coverageOnlyFileNames),
      toChunk(chunk.files.slice(midpoint)),
    ];
  }
  const file = chunk.files[0];
  const characters = Array.from(file.patch ?? '');
  if (characters.length < 2) return undefined;
  const midpoint = Math.ceil(characters.length / 2);
  return [
    toChunk(
      [{ filename: file.filename, patch: characters.slice(0, midpoint).join('') }],
      coverageOnlyFileNames
    ),
    toChunk([{ filename: file.filename, patch: characters.slice(midpoint).join('') }]),
  ];
}

function estimatedTokens(options: EvaluateJevChunksOptions, files: FileWithDiff[]): number {
  return estimateJevRequestTokens(
    stateFor(options, files, { index: 9998, total: 9999 }),
    options.questions
  );
}

function stateFor(
  options: EvaluateJevChunksOptions,
  files: FileWithDiff[],
  position: { index: number; total: number }
): JevReviewState {
  return buildJevReviewState({
    label: options.label,
    files,
    changeSummary: options.changeSummary,
    sourceDescription: options.sourceDescription,
    changeManifest: options.files.map((file) => file.filename),
    chunk: {
      index: position.index + 1,
      total: position.total,
      files: files.map((file) => file.filename),
    },
  });
}

function toChunk(files: FileWithDiff[], coverageOnlyFileNames?: string[]): JevReviewChunk {
  const chunk: JevReviewChunk = {
    files,
    fileNames: [...new Set(files.map((file) => file.filename))],
  };
  if (coverageOnlyFileNames !== undefined && coverageOnlyFileNames.length > 0) {
    chunk.coverageOnlyFileNames = coverageOnlyFileNames;
  }
  return chunk;
}
