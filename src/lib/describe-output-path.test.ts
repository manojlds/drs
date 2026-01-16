import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { writeJsonOutput } from './write-json-output.js';
import { parseDescribeOutput } from './describe-parser.js';
import { OUTPUT_PATHS } from './output-paths.js';

describe('describe output path integration', () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), 'drs-describe-'));
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it('writes describe output to deterministic path and reads it', async () => {
    const payload = {
      type: 'feature',
      title: 'Add deterministic output path usage',
      summary: ['Ensures describe output writes to known location'],
    };

    const pointer = await writeJsonOutput({
      outputType: 'describe_output',
      payload,
      pretty: false,
      workingDir,
    });

    const expectedPath = join(workingDir, OUTPUT_PATHS.describe_output);
    const fileContents = JSON.parse(await readFile(expectedPath, 'utf-8'));
    expect(fileContents).toEqual(payload);

    expect(pointer).toEqual({
      outputType: 'describe_output',
      outputPath: OUTPUT_PATHS.describe_output,
    });

    const parsed = await parseDescribeOutput(workingDir, false, JSON.stringify(pointer));
    expect(parsed).toEqual(payload);
  });

  it('reads describe output from default path without pointer', async () => {
    const payload = {
      type: 'bugfix',
      title: 'Read describe output from default path',
      summary: ['Loads describe output without pointer metadata'],
    };

    const expectedPath = join(workingDir, OUTPUT_PATHS.describe_output);
    await mkdir(dirname(expectedPath), { recursive: true });
    await writeFile(expectedPath, JSON.stringify(payload), 'utf-8');

    const parsed = await parseDescribeOutput(workingDir);
    expect(parsed).toEqual(payload);
  });
});
