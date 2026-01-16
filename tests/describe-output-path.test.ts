import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import writeJsonOutputTool from '../.opencode/tool/write_json_output.js';
import { parseDescribeOutput } from '../src/lib/describe-parser.js';
import { OUTPUT_PATHS } from '../src/lib/output-paths.js';

type WriteJsonOutputTool = {
  execute: (args: {
    outputType: 'describe_output' | 'review_output';
    payload: unknown;
    pretty?: boolean;
    indent?: number;
  }) => Promise<string>;
};

describe('describe output path integration', () => {
  let originalCwd: string;
  let workingDir: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    workingDir = await mkdtemp(join(tmpdir(), 'drs-describe-'));
    process.chdir(workingDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(workingDir, { recursive: true, force: true });
  });

  it('write_json_output writes to deterministic path and parser reads it', async () => {
    const payload = {
      type: 'feature',
      title: 'Add deterministic output path usage',
      summary: ['Ensures describe output writes to known location'],
    };

    const tool = writeJsonOutputTool as WriteJsonOutputTool;
    const pointerJson = await tool.execute({
      outputType: 'describe_output',
      payload,
      pretty: false,
    });

    const expectedPath = join(workingDir, OUTPUT_PATHS.describe_output);
    const fileContents = JSON.parse(await readFile(expectedPath, 'utf-8'));
    expect(fileContents).toEqual(payload);

    const pointer = JSON.parse(pointerJson);
    expect(pointer.outputType).toBe('describe_output');
    expect(pointer.outputPath).toBe(OUTPUT_PATHS.describe_output);

    const parsed = await parseDescribeOutput(workingDir, false, pointerJson);
    expect(parsed).toEqual(payload);
  });

  it('parseDescribeOutput reads from default describe output path', async () => {
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
