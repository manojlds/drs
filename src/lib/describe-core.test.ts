import { describe, it, expect } from 'vitest';
import { buildDescribeInstructions } from './describe-core.js';
import type { FileWithDiff } from './review-core.js';

describe('describe-core', () => {
  describe('buildDescribeInstructions', () => {
    it('should build instructions with diff content', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ const foo = "bar";',
        },
        {
          filename: 'src/utils.ts',
          patch: '- old code\n+ new code',
        },
      ];

      const instructions = buildDescribeInstructions('PR #123', files);

      expect(instructions).toContain('PR #123');
      expect(instructions).toContain('src/app.ts');
      expect(instructions).toContain('src/utils.ts');
      expect(instructions).toContain('Diff Content');
      expect(instructions).toContain('+ const foo = "bar";');
      expect(instructions).toContain('- old code\n+ new code');
      expect(instructions).toContain('write_json_output');
      expect(instructions).toContain('describe_output');
    });

    it('should build instructions without diff content', () => {
      const files: FileWithDiff[] = [
        { filename: 'src/app.ts' },
        { filename: 'src/utils.ts' },
      ];

      const instructions = buildDescribeInstructions('MR !456', files);

      expect(instructions).toContain('MR !456');
      expect(instructions).toContain('src/app.ts');
      expect(instructions).toContain('src/utils.ts');
      expect(instructions).not.toContain('Diff Content');
      expect(instructions).toContain('Changed files:');
    });

    it('should include compression summary when provided', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ new code',
        },
      ];

      const compressionSummary = '⚠️  Context was compressed due to size';
      const instructions = buildDescribeInstructions('PR #123', files, compressionSummary);

      expect(instructions).toContain(compressionSummary);
    });

    it('should include project context when provided', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ new code',
        },
      ];

      const projectContext = 'This is a TypeScript project using Express.';
      const instructions = buildDescribeInstructions('PR #123', files, undefined, projectContext);

      expect(instructions).toContain('Project Context');
      expect(instructions).toContain('This is a TypeScript project using Express.');
    });

    it('should not add duplicate "Project Context" header if already present', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ new code',
        },
      ];

      const projectContext = '# Project Context\n\nExisting header content';
      const instructions = buildDescribeInstructions('PR #123', files, undefined, projectContext);

      // Should only appear once
      const matches = instructions.match(/# Project Context/gi);
      expect(matches).toHaveLength(1);
    });

    it('should handle case-insensitive "project context" header', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ new code',
        },
      ];

      const projectContext = '# project context\n\nLowercase header';
      const instructions = buildDescribeInstructions('PR #123', files, undefined, projectContext);

      // Should not add duplicate header
      const matches = instructions.match(/# project context/gi);
      expect(matches).toHaveLength(1);
    });

    it('should trim project context whitespace', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ new code',
        },
      ];

      const projectContext = '\n\n  Context with whitespace  \n\n';
      const instructions = buildDescribeInstructions('PR #123', files, undefined, projectContext);

      expect(instructions).toContain('Context with whitespace');
      expect(instructions).not.toContain('\n\n  Context with whitespace  \n\n');
    });

    it('should handle empty project context', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ new code',
        },
      ];

      const instructions = buildDescribeInstructions('PR #123', files, undefined, '');

      expect(instructions).not.toContain('Project Context');
    });

    it('should handle files with and without patches mixed', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ has patch',
        },
        {
          filename: 'src/utils.ts',
          // no patch
        },
        {
          filename: 'src/db.ts',
          patch: '+ another patch',
        },
      ];

      const instructions = buildDescribeInstructions('PR #123', files);

      // All files should be listed
      expect(instructions).toContain('src/app.ts');
      expect(instructions).toContain('src/utils.ts');
      expect(instructions).toContain('src/db.ts');

      // Only files with patches should be in diff content
      expect(instructions).toContain('### src/app.ts');
      expect(instructions).toContain('### src/db.ts');
      expect(instructions).not.toContain('### src/utils.ts');
    });

    it('should include all required output schema fields', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ code',
        },
      ];

      const instructions = buildDescribeInstructions('PR #123', files);

      // Check for required schema fields
      expect(instructions).toContain('type');
      expect(instructions).toContain('title');
      expect(instructions).toContain('summary');
      expect(instructions).toContain('walkthrough');
      expect(instructions).toContain('labels');
      expect(instructions).toContain('recommendations');
      expect(instructions).toContain('changeType');
      expect(instructions).toContain('semanticLabel');
      expect(instructions).toContain('significance');
    });

    it('should include instructions about focusing on new/modified code', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ code',
        },
      ];

      const instructions = buildDescribeInstructions('PR #123', files);

      expect(instructions).toContain('Focus on new or modified code');
      expect(instructions).toContain('lines starting with +');
    });

    it('should handle empty files array', () => {
      const files: FileWithDiff[] = [];

      const instructions = buildDescribeInstructions('PR #123', files);

      expect(instructions).toContain('PR #123');
      expect(instructions).toContain('Changed files:');
      expect(instructions).not.toContain('Diff Content');
    });

    it('should include compression summary and project context together', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ code',
        },
      ];

      const compressionSummary = '⚠️  Compressed';
      const projectContext = 'Express project';

      const instructions = buildDescribeInstructions(
        'PR #123',
        files,
        compressionSummary,
        projectContext
      );

      expect(instructions).toContain('Project Context');
      expect(instructions).toContain('Express project');
      expect(instructions).toContain('⚠️  Compressed');
    });

    it('should format diffs with code fences', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ const x = 1;',
        },
      ];

      const instructions = buildDescribeInstructions('PR #123', files);

      expect(instructions).toContain('```diff');
      expect(instructions).toContain('+ const x = 1;');
      expect(instructions).toContain('```');
    });

    it('should include specific label for PR/MR', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ code',
        },
      ];

      const instructionsPR = buildDescribeInstructions('PR #123', files);
      expect(instructionsPR).toContain('PR #123');

      const instructionsMR = buildDescribeInstructions('MR !456', files);
      expect(instructionsMR).toContain('MR !456');
    });
  });
});
