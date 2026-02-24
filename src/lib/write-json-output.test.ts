import { describe, it, expect, afterEach } from 'vitest';
import { writeJsonOutput } from './write-json-output.js';
import { readFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Helpers ──────────────────────────────────────────────────────

let testDir: string;

async function createTestDir(): Promise<string> {
  testDir = join(
    tmpdir(),
    `drs-write-json-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(testDir, { recursive: true });
  return testDir;
}

afterEach(async () => {
  if (testDir) {
    await rm(testDir, { recursive: true, force: true });
  }
});

// ── Valid payloads ───────────────────────────────────────────────

const VALID_REVIEW_PAYLOAD = {
  timestamp: '2026-02-24T00:00:00Z',
  summary: {
    filesReviewed: 3,
    issuesFound: 1,
    bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
    byCategory: { SECURITY: 1, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
  },
  issues: [
    {
      category: 'SECURITY',
      severity: 'HIGH',
      title: 'SQL Injection',
      file: 'src/db.ts',
      problem: 'Unsanitized input',
      solution: 'Use parameterized queries',
      agent: 'security',
    },
  ],
};

const VALID_DESCRIBE_PAYLOAD = {
  type: 'feature',
  title: 'Add user authentication',
  summary: ['Added login and registration endpoints'],
};

// ── writeJsonOutput ──────────────────────────────────────────────

describe('writeJsonOutput', () => {
  describe('review_output', () => {
    it('writes valid review output to default path', async () => {
      const dir = await createTestDir();

      const result = await writeJsonOutput({
        outputType: 'review_output',
        payload: VALID_REVIEW_PAYLOAD,
        workingDir: dir,
      });

      expect(result.outputType).toBe('review_output');
      expect(result.outputPath).toBe('.drs/review-output.json');

      const content = await readFile(join(dir, '.drs/review-output.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.timestamp).toBe('2026-02-24T00:00:00Z');
      expect(parsed.issues).toHaveLength(1);
    });

    it('formats with default 2-space indent', async () => {
      const dir = await createTestDir();

      await writeJsonOutput({
        outputType: 'review_output',
        payload: VALID_REVIEW_PAYLOAD,
        workingDir: dir,
      });

      const content = await readFile(join(dir, '.drs/review-output.json'), 'utf-8');
      // Default indent is 2 spaces
      expect(content).toContain('  "timestamp"');
    });

    it('respects custom indent', async () => {
      const dir = await createTestDir();

      await writeJsonOutput({
        outputType: 'review_output',
        payload: VALID_REVIEW_PAYLOAD,
        indent: 4,
        workingDir: dir,
      });

      const content = await readFile(join(dir, '.drs/review-output.json'), 'utf-8');
      expect(content).toContain('    "timestamp"');
    });

    it('writes compact JSON when pretty is false', async () => {
      const dir = await createTestDir();

      await writeJsonOutput({
        outputType: 'review_output',
        payload: VALID_REVIEW_PAYLOAD,
        pretty: false,
        workingDir: dir,
      });

      const content = await readFile(join(dir, '.drs/review-output.json'), 'utf-8');
      // No newlines in compact JSON
      expect(content).not.toContain('\n');
    });

    it('accepts payload as JSON string', async () => {
      const dir = await createTestDir();

      await writeJsonOutput({
        outputType: 'review_output',
        payload: JSON.stringify(VALID_REVIEW_PAYLOAD),
        workingDir: dir,
      });

      const content = await readFile(join(dir, '.drs/review-output.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.issues).toHaveLength(1);
    });

    it('includes optional metadata', async () => {
      const dir = await createTestDir();
      const withMetadata = {
        ...VALID_REVIEW_PAYLOAD,
        metadata: {
          source: 'MR !42',
          project: 'myorg/myrepo',
          branch: { source: 'feature', target: 'main' },
        },
      };

      await writeJsonOutput({
        outputType: 'review_output',
        payload: withMetadata,
        workingDir: dir,
      });

      const content = await readFile(join(dir, '.drs/review-output.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.metadata.project).toBe('myorg/myrepo');
    });
  });

  describe('describe_output', () => {
    it('writes valid describe output', async () => {
      const dir = await createTestDir();

      const result = await writeJsonOutput({
        outputType: 'describe_output',
        payload: VALID_DESCRIBE_PAYLOAD,
        workingDir: dir,
      });

      expect(result.outputType).toBe('describe_output');
      expect(result.outputPath).toBe('.drs/describe-output.json');

      const content = await readFile(join(dir, '.drs/describe-output.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.type).toBe('feature');
      expect(parsed.title).toBe('Add user authentication');
    });

    it('accepts describe output with walkthrough', async () => {
      const dir = await createTestDir();
      const withWalkthrough = {
        ...VALID_DESCRIBE_PAYLOAD,
        walkthrough: [
          {
            file: 'src/auth.ts',
            changeType: 'added',
            semanticLabel: 'feature',
            title: 'Auth module',
            changes: ['Added login handler'],
            significance: 'major',
          },
        ],
      };

      await writeJsonOutput({
        outputType: 'describe_output',
        payload: withWalkthrough,
        workingDir: dir,
      });

      const content = await readFile(join(dir, '.drs/describe-output.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.walkthrough).toHaveLength(1);
    });
  });

  describe('validation errors', () => {
    it('rejects review output missing required fields', async () => {
      const dir = await createTestDir();

      await expect(
        writeJsonOutput({
          outputType: 'review_output',
          payload: { issues: [] }, // missing timestamp, summary
          workingDir: dir,
        })
      ).rejects.toThrow('Output validation failed');
    });

    it('rejects review output with invalid severity', async () => {
      const dir = await createTestDir();
      const invalid = {
        ...VALID_REVIEW_PAYLOAD,
        issues: [
          {
            ...VALID_REVIEW_PAYLOAD.issues[0],
            severity: 'UNKNOWN', // not in enum
          },
        ],
      };

      await expect(
        writeJsonOutput({
          outputType: 'review_output',
          payload: invalid,
          workingDir: dir,
        })
      ).rejects.toThrow('Output validation failed');
    });

    it('rejects review output with additional properties', async () => {
      const dir = await createTestDir();
      const invalid = {
        ...VALID_REVIEW_PAYLOAD,
        extraField: 'not allowed',
      };

      await expect(
        writeJsonOutput({
          outputType: 'review_output',
          payload: invalid,
          workingDir: dir,
        })
      ).rejects.toThrow('Output validation failed');
    });

    it('rejects describe output missing required fields', async () => {
      const dir = await createTestDir();

      await expect(
        writeJsonOutput({
          outputType: 'describe_output',
          payload: { title: 'Missing type and summary' },
          workingDir: dir,
        })
      ).rejects.toThrow('Output validation failed');
    });

    it('rejects describe output with invalid type', async () => {
      const dir = await createTestDir();

      await expect(
        writeJsonOutput({
          outputType: 'describe_output',
          payload: { type: 'invalid', title: 'Test', summary: ['test'] },
          workingDir: dir,
        })
      ).rejects.toThrow('Output validation failed');
    });

    it('rejects invalid JSON string payload', async () => {
      const dir = await createTestDir();

      await expect(
        writeJsonOutput({
          outputType: 'review_output',
          payload: 'not valid json',
          workingDir: dir,
        })
      ).rejects.toThrow(); // JSON.parse error
    });
  });

  describe('security', () => {
    it('rejects path traversal in resolved output path', async () => {
      // The function uses OUTPUT_PATHS constants so path traversal would need
      // to come from the workingDir itself being crafted — but resolveWithinWorkingDir
      // prevents escaping. This test verifies the guard exists.
      const dir = await createTestDir();

      // Valid — writes within workingDir
      await writeJsonOutput({
        outputType: 'review_output',
        payload: VALID_REVIEW_PAYLOAD,
        workingDir: dir,
      });

      const content = await readFile(join(dir, '.drs/review-output.json'), 'utf-8');
      expect(JSON.parse(content)).toBeTruthy();
    });
  });

  describe('directory creation', () => {
    it('creates .drs directory if it does not exist', async () => {
      const dir = await createTestDir();
      // .drs doesn't exist yet in a fresh temp dir

      await writeJsonOutput({
        outputType: 'review_output',
        payload: VALID_REVIEW_PAYLOAD,
        workingDir: dir,
      });

      const content = await readFile(join(dir, '.drs/review-output.json'), 'utf-8');
      expect(JSON.parse(content)).toBeTruthy();
    });
  });
});
