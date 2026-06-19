import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractHtmlDocument,
  parseArtifactOutputPointer,
  validateHtmlArtifact,
  writeArtifactOutput,
} from './html-artifact.js';

let testDir: string | undefined;

async function createTestDir(): Promise<string> {
  testDir = join(
    tmpdir(),
    `drs-html-artifact-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(testDir, { recursive: true });
  return testDir;
}

afterEach(async () => {
  if (testDir) {
    await rm(testDir, { recursive: true, force: true });
    testDir = undefined;
  }
});

describe('html artifact output', () => {
  it('extracts a complete HTML document from surrounding text', () => {
    expect(extractHtmlDocument('before\n<!DOCTYPE html><html><body>ok</body></html>\nafter')).toBe(
      '<!DOCTYPE html><html><body>ok</body></html>'
    );
  });

  it('rejects artifacts without a closing html tag', () => {
    expect(() => extractHtmlDocument('<!DOCTYPE html><html><body>open')).toThrow('closing </html>');
  });

  it('validates strict artifact boundaries', () => {
    expect(() => validateHtmlArtifact('prose\n<!DOCTYPE html><html></html>')).toThrow(
      'must start with <!DOCTYPE html>'
    );
    expect(() => validateHtmlArtifact('```html\n<!DOCTYPE html><html></html>\n```')).toThrow(
      'must start with <!DOCTYPE html>'
    );
  });

  it('writes sanitized HTML and returns an artifact pointer', async () => {
    const dir = await createTestDir();
    const pointer = await writeArtifactOutput({
      outputPath: '.drs/visual.html',
      content: 'thinking\n<!DOCTYPE html><html><body>Visual</body></html>\ndone',
      workingDir: dir,
    });

    expect(pointer).toEqual({ outputType: 'artifact_output', outputPath: '.drs/visual.html' });
    await expect(readFile(join(dir, '.drs/visual.html'), 'utf-8')).resolves.toBe(
      '<!DOCTYPE html><html><body>Visual</body></html>'
    );
  });

  it('parses artifact output pointers', () => {
    expect(
      parseArtifactOutputPointer('{"outputType":"artifact_output","outputPath":".drs/visual.html"}')
    ).toEqual({ outputType: 'artifact_output', outputPath: '.drs/visual.html' });
    expect(parseArtifactOutputPointer('{"outputType":"review_output"}')).toBeUndefined();
  });
});
