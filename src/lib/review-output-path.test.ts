import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeJsonOutput } from './write-json-output.js';
import { parseReviewOutput } from './review-parser.js';
import { OUTPUT_PATHS } from './output-paths.js';

describe('review output path integration', () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), 'drs-review-'));
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it('writes review output to deterministic path and reads it', async () => {
    const payload = {
      timestamp: '2024-01-01T00:00:00.000Z',
      summary: {
        filesReviewed: 2,
        issuesFound: 0,
        bySeverity: {
          CRITICAL: 0,
          HIGH: 0,
          MEDIUM: 0,
          LOW: 0,
        },
        byCategory: {
          SECURITY: 0,
          QUALITY: 0,
          STYLE: 0,
          PERFORMANCE: 0,
          DOCUMENTATION: 0,
        },
      },
      issues: [],
    };

    const pointer = await writeJsonOutput({
      outputType: 'review_output',
      payload,
      pretty: false,
      workingDir,
    });

    const expectedPath = join(workingDir, OUTPUT_PATHS.review_output);
    const fileContents = JSON.parse(await readFile(expectedPath, 'utf-8'));
    expect(fileContents).toEqual(payload);

    expect(pointer).toEqual({
      outputType: 'review_output',
      outputPath: OUTPUT_PATHS.review_output,
    });

    const parsed = await parseReviewOutput(workingDir, false, JSON.stringify(pointer));
    expect(parsed).toEqual(payload);
  });

  it('reads review output from default path without pointer', async () => {
    const payload = {
      timestamp: '2024-01-01T00:00:00.000Z',
      summary: {
        filesReviewed: 1,
        issuesFound: 0,
        bySeverity: {
          CRITICAL: 0,
          HIGH: 0,
          MEDIUM: 0,
          LOW: 0,
        },
        byCategory: {
          SECURITY: 0,
          QUALITY: 0,
          STYLE: 0,
          PERFORMANCE: 0,
          DOCUMENTATION: 0,
        },
      },
      issues: [],
    };

    const expectedPath = join(workingDir, OUTPUT_PATHS.review_output);
    await writeFile(expectedPath, JSON.stringify(payload), 'utf-8');

    const parsed = await parseReviewOutput(workingDir);
    expect(parsed).toEqual(payload);
  });
});
