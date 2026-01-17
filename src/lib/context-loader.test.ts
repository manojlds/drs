import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadGlobalContext,
  loadAgentContext,
  buildReviewPrompt,
  type AgentContext,
} from './context-loader.js';
import { existsSync, readFileSync } from 'fs';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('context-loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadGlobalContext', () => {
    it('should load global context when file exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('# Project Context\n\nThis is project context');

      const result = loadGlobalContext('/test/project');

      expect(result).toBe('# Project Context\n\nThis is project context');
      expect(existsSync).toHaveBeenCalledWith('/test/project/.drs/context.md');
      expect(readFileSync).toHaveBeenCalledWith('/test/project/.drs/context.md', 'utf-8');
    });

    it('should return null when file does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = loadGlobalContext('/test/project');

      expect(result).toBeNull();
      expect(existsSync).toHaveBeenCalledWith('/test/project/.drs/context.md');
      expect(readFileSync).not.toHaveBeenCalled();
    });

    it('should use process.cwd() as default project root', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const originalCwd = process.cwd();

      loadGlobalContext();

      expect(existsSync).toHaveBeenCalledWith(`${originalCwd}/.drs/context.md`);
    });
  });

  describe('loadAgentContext', () => {
    it('should load full agent override when agent.md exists', () => {
      // Mock agent.md exists
      vi.mocked(existsSync).mockImplementation((path) => {
        return path.toString().includes('agent.md');
      });
      vi.mocked(readFileSync).mockReturnValue('# Custom Agent\n\nCustom agent definition');

      const result = loadAgentContext('security', '/test/project');

      expect(result).toEqual({
        source: 'override',
        agentDefinition: '# Custom Agent\n\nCustom agent definition',
      });
      expect(existsSync).toHaveBeenCalledWith('/test/project/.drs/agents/security/agent.md');
    });

    it('should load agent context when context.md exists but not agent.md', () => {
      // Mock only context.md exists
      vi.mocked(existsSync).mockImplementation((path) => {
        return path.toString().includes('context.md') && !path.toString().includes('agent.md');
      });
      vi.mocked(readFileSync).mockReturnValue('Agent-specific context');

      const result = loadAgentContext('quality', '/test/project');

      expect(result).toEqual({
        source: 'default',
        agentContext: 'Agent-specific context',
      });
      expect(existsSync).toHaveBeenCalledWith('/test/project/.drs/agents/quality/agent.md');
      expect(existsSync).toHaveBeenCalledWith('/test/project/.drs/agents/quality/context.md');
    });

    it('should return default when no customization exists', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = loadAgentContext('style', '/test/project');

      expect(result).toEqual({
        source: 'default',
      });
      expect(existsSync).toHaveBeenCalledWith('/test/project/.drs/agents/style/agent.md');
      expect(existsSync).toHaveBeenCalledWith('/test/project/.drs/agents/style/context.md');
    });

    it('should use process.cwd() as default project root', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const originalCwd = process.cwd();

      loadAgentContext('security');

      expect(existsSync).toHaveBeenCalledWith(`${originalCwd}/.drs/agents/security/agent.md`);
    });
  });

  describe('buildReviewPrompt', () => {
    it('should use full agent override when available', () => {
      // Mock agent override
      vi.mocked(existsSync).mockImplementation((path) => {
        return path.toString().includes('agent.md');
      });
      vi.mocked(readFileSync).mockReturnValue('# Custom Security Agent\n\nCustom instructions');

      const result = buildReviewPrompt(
        'security',
        'Default base prompt',
        'PR #123',
        ['src/app.ts', 'src/utils.ts'],
        '/test/project'
      );

      expect(result).toContain('# Custom Security Agent');
      expect(result).toContain('Custom instructions');
      expect(result).toContain('Review the following files from PR #123');
      expect(result).toContain('- src/app.ts');
      expect(result).toContain('- src/utils.ts');
      expect(result).not.toContain('Default base prompt');
    });

    it('should build prompt with global context and base prompt', () => {
      // Mock global context exists, no agent override
      vi.mocked(existsSync).mockImplementation((path) => {
        const pathStr = path.toString();
        return pathStr.includes('.drs/context.md');
      });

      let readCallCount = 0;
      vi.mocked(readFileSync).mockImplementation((path) => {
        readCallCount++;
        if (path.toString().includes('.drs/context.md')) {
          return '# Project Context\n\nThis is our project';
        }
        return '';
      });

      const result = buildReviewPrompt(
        'quality',
        'Review code quality',
        'MR !456',
        ['lib/index.ts'],
        '/test/project'
      );

      expect(result).toContain('# Project Context');
      expect(result).toContain('This is our project');
      expect(result).toContain('Review code quality');
    });

    it('should add Project Context header when not present in global context', () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return path.toString().includes('.drs/context.md');
      });
      vi.mocked(readFileSync).mockReturnValue('Just some context without header');

      const result = buildReviewPrompt(
        'security',
        'Base instructions',
        'PR #1',
        ['file.ts'],
        '/test/project'
      );

      expect(result).toContain('# Project Context\n\nJust some context without header');
    });

    it('should not duplicate Project Context header when already present', () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return path.toString().includes('.drs/context.md');
      });
      vi.mocked(readFileSync).mockReturnValue('# Project Context\n\nAlready has header');

      const result = buildReviewPrompt(
        'security',
        'Base instructions',
        'PR #1',
        ['file.ts'],
        '/test/project'
      );

      // Should not have double "# Project Context"
      const matches = result.match(/# Project Context/g);
      expect(matches).toHaveLength(1);
    });

    it('should build prompt with agent-specific context', () => {
      // Mock agent context exists
      vi.mocked(existsSync).mockImplementation((path) => {
        const pathStr = path.toString();
        return pathStr.includes('agents/security/context.md');
      });
      vi.mocked(readFileSync).mockReturnValue('Focus on authentication and authorization');

      const result = buildReviewPrompt(
        'security',
        'Base security review',
        'PR #2',
        ['auth.ts'],
        '/test/project'
      );

      expect(result).toContain('# Security Agent Context');
      expect(result).toContain('Focus on authentication and authorization');
      expect(result).toContain('Base security review');
    });

    it('should capitalize agent name in agent context header', () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return path.toString().includes('agents/quality/context.md');
      });
      vi.mocked(readFileSync).mockReturnValue('Quality context');

      const result = buildReviewPrompt(
        'quality',
        'Base prompt',
        'PR #3',
        ['file.ts'],
        '/test/project'
      );

      expect(result).toContain('# Quality Agent Context');
    });

    it('should build prompt with all contexts (global + agent + base)', () => {
      // Mock both global and agent context
      vi.mocked(existsSync).mockImplementation((path) => {
        const pathStr = path.toString();
        return (
          pathStr.includes('.drs/context.md') || pathStr.includes('agents/security/context.md')
        );
      });

      let readCallCount = 0;
      vi.mocked(readFileSync).mockImplementation((path) => {
        readCallCount++;
        if (path.toString().includes('.drs/context.md')) {
          return 'Global project context';
        }
        if (path.toString().includes('agents/security/context.md')) {
          return 'Security-specific context';
        }
        return '';
      });

      const result = buildReviewPrompt(
        'security',
        'Base security instructions',
        'PR #4',
        ['auth.ts'],
        '/test/project'
      );

      expect(result).toContain('Global project context');
      expect(result).toContain('Security-specific context');
      expect(result).toContain('Base security instructions');
    });

    it('should handle empty file list', () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return path.toString().includes('agent.md');
      });
      vi.mocked(readFileSync).mockReturnValue('Custom agent');

      const result = buildReviewPrompt(
        'security',
        'Base prompt',
        'PR #5',
        [],
        '/test/project'
      );

      expect(result).toContain('Review the following files from PR #5');
      // Should still work with no files listed
    });

    it('should use process.cwd() as default project root', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const originalCwd = process.cwd();

      buildReviewPrompt('security', 'Base prompt', 'PR #1', ['file.ts']);

      expect(existsSync).toHaveBeenCalledWith(`${originalCwd}/.drs/context.md`);
      expect(existsSync).toHaveBeenCalledWith(`${originalCwd}/.drs/agents/security/agent.md`);
    });

    it('should handle whitespace-only global context', () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return path.toString().includes('.drs/context.md');
      });
      vi.mocked(readFileSync).mockReturnValue('   \n\n   ');

      const result = buildReviewPrompt(
        'security',
        'Base prompt',
        'PR #1',
        ['file.ts'],
        '/test/project'
      );

      // Whitespace is preserved and wrapped with header
      expect(result).toContain('# Project Context');
      expect(result).toContain('Base prompt');
    });

    it('should handle context with multiple empty lines before content', () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return path.toString().includes('.drs/context.md');
      });
      vi.mocked(readFileSync).mockReturnValue('\n\n\n# Project Context\n\nContent here');

      const result = buildReviewPrompt(
        'security',
        'Base prompt',
        'PR #1',
        ['file.ts'],
        '/test/project'
      );

      expect(result).toContain('# Project Context\n\nContent here');
      expect(result).not.toMatch(/^\n+/); // Should not start with newlines
    });
  });
});
