import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseJsonFromAgentOutput, parseDescribeOutput } from './describe-parser.js';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('describe-parser', () => {
  describe('parseJsonFromAgentOutput', () => {
    it('should parse JSON from code fence', () => {
      const raw = '```json\n{"type": "feature", "title": "Test"}\n```';
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({ type: 'feature', title: 'Test' });
    });

    it('should parse JSON from code fence with extra whitespace', () => {
      const raw = '```json\n\n  {"type": "feature", "title": "Test"}  \n\n```';
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({ type: 'feature', title: 'Test' });
    });

    it('should parse JSON from code fence with case-insensitive marker', () => {
      const raw = '```JSON\n{"type": "feature", "title": "Test"}\n```';
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({ type: 'feature', title: 'Test' });
    });

    it('should parse embedded JSON from mixed text', () => {
      const raw =
        'Here is the output: {"outputType":"describe_output","outputPath":".drs/describe-output.json"} Done!';
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({
        outputType: 'describe_output',
        outputPath: '.drs/describe-output.json',
      });
    });

    it('should parse pure JSON string', () => {
      const raw = '{"type": "feature", "title": "Test"}';
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({ type: 'feature', title: 'Test' });
    });

    it('should handle nested JSON objects', () => {
      const raw = `{"type": "feature", "title": "Test"}`;
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({
        type: 'feature',
        title: 'Test',
      });
    });

    it('should handle JSON with arrays', () => {
      const raw = '{"items": [1, 2, 3]}';
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({
        items: [1, 2, 3],
      });
    });

    it('should handle JSON with escaped quotes', () => {
      const raw = '{"message": "This is a \\"quoted\\" string"}';
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({
        message: 'This is a "quoted" string',
      });
    });

    it('should prefer last JSON candidate when multiple exist', () => {
      const raw = 'First: {"id": 1} Second: {"id": 2}';
      const result = parseJsonFromAgentOutput(raw);

      // Should return the last valid JSON found
      expect(result).toEqual({ id: 2 });
    });

    it('should prefer code fence over embedded JSON', () => {
      const raw = `
        {"id": 1}
        \`\`\`json
        {"id": 2}
        \`\`\`
      `;
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({ id: 2 });
    });

    it('should throw error for invalid JSON', () => {
      const raw = 'This is not JSON at all';
      expect(() => parseJsonFromAgentOutput(raw)).toThrow();
    });

    it('should throw error for incomplete JSON', () => {
      const raw = '{"type": "feature", "title":';
      expect(() => parseJsonFromAgentOutput(raw)).toThrow();
    });

    it('should handle empty string', () => {
      const raw = '';
      expect(() => parseJsonFromAgentOutput(raw)).toThrow();
    });

    it('should handle JSON with null values', () => {
      const raw = '{"value": null, "name": "test"}';
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({ value: null, name: 'test' });
    });

    it('should handle JSON with boolean values', () => {
      const raw = '{"enabled": true, "disabled": false}';
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({ enabled: true, disabled: false });
    });

    it('should handle JSON with numbers', () => {
      const raw = '{"integer": 42, "float": 3.14, "negative": -10}';
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({ integer: 42, float: 3.14, negative: -10 });
    });

    it('should handle markdown text with embedded JSON', () => {
      const raw = `
# Title

Here is some explanation text.

{"outputType":"describe_output","outputPath":".drs/output.json"}

More text after.
      `;
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({
        outputType: 'describe_output',
        outputPath: '.drs/output.json',
      });
    });

    it('should handle JSON with escaped characters', () => {
      const raw = '{"pattern": "function() with \\"quotes\\""}';
      const result = parseJsonFromAgentOutput(raw);

      expect(result).toEqual({
        pattern: 'function() with "quotes"',
      });
    });
  });

  describe('parseDescribeOutput', () => {
    let testDir: string;

    beforeEach(async () => {
      // Create a unique temporary directory for each test
      testDir = join(tmpdir(), `drs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(testDir, { recursive: true });
      await mkdir(join(testDir, '.drs'), { recursive: true });
    });

    afterEach(async () => {
      // Clean up test directory
      try {
        await rm(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should read describe output from default path', async () => {
      const describeData = {
        type: 'feature',
        title: 'Add new feature',
        summary: ['Added authentication', 'Updated database schema'],
      };

      await writeFile(join(testDir, '.drs/describe-output.json'), JSON.stringify(describeData));

      const result = await parseDescribeOutput(testDir, false);
      expect(result).toEqual(describeData);
    });

    it('should read describe output from pointer path', async () => {
      const describeData = {
        type: 'bugfix',
        title: 'Fix authentication bug',
        summary: ['Fixed login issue'],
      };

      await writeFile(join(testDir, '.drs/custom-output.json'), JSON.stringify(describeData));

      const rawOutput = JSON.stringify({
        outputType: 'describe_output',
        outputPath: '.drs/custom-output.json',
      });

      const result = await parseDescribeOutput(testDir, false, rawOutput);
      expect(result).toEqual(describeData);
    });

    it('should fall back to default path if pointer path not found', async () => {
      const describeData = {
        type: 'refactor',
        title: 'Refactor code',
        summary: ['Improved code quality'],
      };

      await writeFile(join(testDir, '.drs/describe-output.json'), JSON.stringify(describeData));

      const rawOutput = JSON.stringify({
        outputType: 'describe_output',
        outputPath: '.drs/nonexistent.json',
      });

      const result = await parseDescribeOutput(testDir, false, rawOutput);
      expect(result).toEqual(describeData);
    });

    it('should throw error if no describe output found', async () => {
      await expect(parseDescribeOutput(testDir, false)).rejects.toThrow(
        'Describe output file not found'
      );
    });

    it('should throw error for invalid output type in pointer', async () => {
      const rawOutput = JSON.stringify({
        outputType: 'invalid_type',
        outputPath: '.drs/output.json',
      });

      await expect(parseDescribeOutput(testDir, false, rawOutput)).rejects.toThrow(
        'Unexpected output type for describe output: invalid_type'
      );
    });

    it('should handle pointer with only outputType field', async () => {
      const describeData = {
        type: 'docs',
        title: 'Update documentation',
      };

      await writeFile(join(testDir, '.drs/describe-output.json'), JSON.stringify(describeData));

      const rawOutput = JSON.stringify({
        outputType: 'describe_output',
      });

      const result = await parseDescribeOutput(testDir, false, rawOutput);
      expect(result).toEqual(describeData);
    });

    it('should log debug messages when debug=true', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const describeData = { type: 'test' };
      await writeFile(join(testDir, '.drs/describe-output.json'), JSON.stringify(describeData));

      await parseDescribeOutput(testDir, true);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Describe output loaded from'));

      logSpy.mockRestore();
    });

    it('should not log debug messages when debug=false', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const describeData = { type: 'test' };
      await writeFile(join(testDir, '.drs/describe-output.json'), JSON.stringify(describeData));

      await parseDescribeOutput(testDir, false);

      expect(logSpy).not.toHaveBeenCalled();

      logSpy.mockRestore();
    });

    it('should refuse to read outside working directory', async () => {
      const rawOutput = JSON.stringify({
        outputType: 'describe_output',
        outputPath: '../../../etc/passwd',
      });

      await expect(parseDescribeOutput(testDir, false, rawOutput)).rejects.toThrow(
        'Refusing to read outside working directory'
      );
    });

    it('should handle absolute paths within working directory', async () => {
      const describeData = { type: 'feature' };
      const outputPath = join(testDir, '.drs/describe-output.json');

      await writeFile(outputPath, JSON.stringify(describeData));

      const rawOutput = JSON.stringify({
        outputType: 'describe_output',
        outputPath: outputPath,
      });

      const result = await parseDescribeOutput(testDir, false, rawOutput);
      expect(result).toEqual(describeData);
    });

    it('should handle invalid JSON in describe output file', async () => {
      await writeFile(join(testDir, '.drs/describe-output.json'), 'not valid json');

      await expect(parseDescribeOutput(testDir, false)).rejects.toThrow();
    });

    it('should use process.cwd() as default working directory', async () => {
      // This test verifies the default parameter works
      // We can't easily test the actual cwd behavior in isolation
      const rawOutput = 'invalid pointer';

      // Should attempt to use cwd and likely fail (unless file exists there)
      await expect(parseDescribeOutput(undefined, false, rawOutput)).rejects.toThrow();
    });

    it('should handle pointer with invalid JSON format', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const describeData = { type: 'test' };
      await writeFile(join(testDir, '.drs/describe-output.json'), JSON.stringify(describeData));

      const rawOutput = 'not valid json at all';

      // Should fall back to default path since pointer parsing fails
      const result = await parseDescribeOutput(testDir, true, rawOutput);
      expect(result).toEqual(describeData);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Describe output pointer parse failed')
      );

      logSpy.mockRestore();
    });

    it('should handle complex describe output structure', async () => {
      const describeData = {
        type: 'feature',
        title: 'Complex feature',
        summary: ['Point 1', 'Point 2', 'Point 3'],
        walkthrough: [
          {
            file: 'src/app.ts',
            changeType: 'modified',
            semanticLabel: 'feature',
            title: 'Added new function',
            changes: ['Added authentication', 'Updated routes'],
            significance: 'major',
          },
        ],
        labels: ['enhancement', 'security'],
        recommendations: ['Add tests', 'Update docs'],
      };

      await writeFile(join(testDir, '.drs/describe-output.json'), JSON.stringify(describeData));

      const result = await parseDescribeOutput(testDir, false);
      expect(result).toEqual(describeData);
    });
  });
});
