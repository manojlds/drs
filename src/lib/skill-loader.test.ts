import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadSkills, getAgentSkills, buildSkillsContext } from './skill-loader.js';
import type { DRSConfig } from './config.js';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('skill-loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockConfig: DRSConfig = {
    opencode: {},
    gitlab: { url: 'https://gitlab.com', token: '' },
    github: { token: '' },
    review: {
      agents: ['security', 'quality'],
      defaultModel: 'test-model',
      ignorePatterns: [],
      mode: 'multi-agent',
    },
    skills: {
      enabled: true,
      directory: '.drs/skills',
      global: [],
    },
  };

  describe('loadSkills', () => {
    it('should return empty array when skills are disabled', () => {
      const config = { ...mockConfig, skills: { ...mockConfig.skills, enabled: false } };

      const result = loadSkills(config, '/test/project');

      expect(result).toEqual([]);
      expect(existsSync).not.toHaveBeenCalled();
    });

    it('should return empty array when skills directory does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = loadSkills(mockConfig, '/test/project');

      expect(result).toEqual([]);
      expect(existsSync).toHaveBeenCalledWith('/test/project/.drs/skills');
      expect(readdirSync).not.toHaveBeenCalled();
    });

    it('should load skills from skill directories', () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        const pathStr = path.toString();
        return (
          pathStr.includes('.drs/skills') ||
          pathStr.includes('code-review-best-practices/SKILL.md') ||
          pathStr.includes('security-patterns/SKILL.md')
        );
      });

      vi.mocked(readdirSync).mockReturnValue([
        'code-review-best-practices' as any,
        'security-patterns' as any,
        'README.md' as any,
      ]);

      vi.mocked(statSync).mockImplementation((path) => {
        const pathStr = path.toString();
        if (pathStr.includes('README.md')) {
          return { isDirectory: () => false } as any;
        }
        return { isDirectory: () => true } as any;
      });

      vi.mocked(readFileSync).mockImplementation((path) => {
        if (path.toString().includes('code-review-best-practices')) {
          return '# Code Review Best Practices\n\nBest practices for code reviews...';
        }
        if (path.toString().includes('security-patterns')) {
          return '# Security Patterns\n\nSecurity patterns to follow...';
        }
        return '';
      });

      const result = loadSkills(mockConfig, '/test/project');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'code-review-best-practices',
        path: '/test/project/.drs/skills/code-review-best-practices/SKILL.md',
        content: '# Code Review Best Practices\n\nBest practices for code reviews...',
      });
      expect(result[1]).toEqual({
        name: 'security-patterns',
        path: '/test/project/.drs/skills/security-patterns/SKILL.md',
        content: '# Security Patterns\n\nSecurity patterns to follow...',
      });
    });

    it('should skip directories without SKILL.md file', () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        const pathStr = path.toString();
        return (
          pathStr.includes('.drs/skills') && !pathStr.includes('incomplete-skill/SKILL.md')
        );
      });

      vi.mocked(readdirSync).mockReturnValue([
        'complete-skill' as any,
        'incomplete-skill' as any,
      ]);

      vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

      vi.mocked(readFileSync).mockReturnValue('# Complete Skill\n\nSkill content');

      const result = loadSkills(mockConfig, '/test/project');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('complete-skill');
    });

    it('should handle errors when reading skills directory gracefully', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = loadSkills(mockConfig, '/test/project');

      expect(result).toEqual([]);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read skills directory'),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it('should handle errors when loading individual skills', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['broken-skill' as any]);
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('Read error');
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = loadSkills(mockConfig, '/test/project');

      expect(result).toEqual([]);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load skill'),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it('should use custom skills directory from config', () => {
      const config = { ...mockConfig, skills: { ...mockConfig.skills, directory: 'custom/skills' } };
      vi.mocked(existsSync).mockReturnValue(false);

      loadSkills(config, '/test/project');

      expect(existsSync).toHaveBeenCalledWith('/test/project/custom/skills');
    });
  });

  describe('getAgentSkills', () => {
    beforeEach(() => {
      // Setup mock skills
      vi.mocked(existsSync).mockImplementation((path) => {
        const pathStr = path.toString();
        return (
          pathStr.includes('.drs/skills') ||
          pathStr.includes('skill1/SKILL.md') ||
          pathStr.includes('skill2/SKILL.md') ||
          pathStr.includes('skill3/SKILL.md')
        );
      });

      vi.mocked(readdirSync).mockReturnValue(['skill1' as any, 'skill2' as any, 'skill3' as any]);
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);
      vi.mocked(readFileSync).mockImplementation((path) => {
        if (path.toString().includes('skill1')) return 'Skill 1 content';
        if (path.toString().includes('skill2')) return 'Skill 2 content';
        if (path.toString().includes('skill3')) return 'Skill 3 content';
        return '';
      });
    });

    it('should return empty array when skills are disabled', () => {
      const config = { ...mockConfig, skills: { ...mockConfig.skills, enabled: false } };

      const result = getAgentSkills(config, 'security', '/test/project');

      expect(result).toEqual([]);
    });

    it('should return global skills for an agent', () => {
      const config = { ...mockConfig, skills: { ...mockConfig.skills, global: ['skill1', 'skill2'] } };

      const result = getAgentSkills(config, 'security', '/test/project');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('skill1');
      expect(result[1].name).toBe('skill2');
    });

    it('should return agent-specific skills', () => {
      const config = {
        ...mockConfig,
        review: {
          ...mockConfig.review,
          agents: [
            { name: 'security', skills: ['skill1', 'skill3'] },
            'quality',
          ],
        },
      };

      const result = getAgentSkills(config, 'security', '/test/project');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('skill1');
      expect(result[1].name).toBe('skill3');
    });

    it('should combine global and agent-specific skills', () => {
      const config = {
        ...mockConfig,
        skills: { ...mockConfig.skills, global: ['skill1'] },
        review: {
          ...mockConfig.review,
          agents: [
            { name: 'security', skills: ['skill2'] },
            'quality',
          ],
        },
      };

      const result = getAgentSkills(config, 'security', '/test/project');

      expect(result).toHaveLength(2);
      expect(result.map((s) => s.name).sort()).toEqual(['skill1', 'skill2']);
    });

    it('should deduplicate skills from global and agent-specific lists', () => {
      const config = {
        ...mockConfig,
        skills: { ...mockConfig.skills, global: ['skill1', 'skill2'] },
        review: {
          ...mockConfig.review,
          agents: [
            { name: 'security', skills: ['skill1', 'skill3'] },
            'quality',
          ],
        },
      };

      const result = getAgentSkills(config, 'security', '/test/project');

      expect(result).toHaveLength(3);
      expect(result.map((s) => s.name).sort()).toEqual(['skill1', 'skill2', 'skill3']);
    });

    it('should return empty array for agent with no skills', () => {
      const config = { ...mockConfig };

      const result = getAgentSkills(config, 'quality', '/test/project');

      expect(result).toEqual([]);
    });

    it('should handle agent specified as string in config', () => {
      const config = {
        ...mockConfig,
        skills: { ...mockConfig.skills, global: ['skill1'] },
        review: {
          ...mockConfig.review,
          agents: ['security', 'quality'],
        },
      };

      const result = getAgentSkills(config, 'security', '/test/project');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('skill1');
    });
  });

  describe('buildSkillsContext', () => {
    it('should return empty string for empty skills array', () => {
      const result = buildSkillsContext([]);

      expect(result).toBe('');
    });

    it('should build skills context with single skill', () => {
      const skills = [
        {
          name: 'code-review',
          path: '/path/to/SKILL.md',
          content: '# Code Review Guidelines\n\nFollow these guidelines...',
        },
      ];

      const result = buildSkillsContext(skills);

      expect(result).toContain('# Available Skills');
      expect(result).toContain('## Skill: code-review');
      expect(result).toContain('# Code Review Guidelines');
      expect(result).toContain('Follow these guidelines...');
      expect(result).toContain('Use these skills as guidance');
    });

    it('should build skills context with multiple skills', () => {
      const skills = [
        {
          name: 'skill1',
          path: '/path/to/skill1/SKILL.md',
          content: 'Skill 1 content',
        },
        {
          name: 'skill2',
          path: '/path/to/skill2/SKILL.md',
          content: 'Skill 2 content',
        },
      ];

      const result = buildSkillsContext(skills);

      expect(result).toContain('# Available Skills');
      expect(result).toContain('## Skill: skill1');
      expect(result).toContain('Skill 1 content');
      expect(result).toContain('---'); // Separator between skills
      expect(result).toContain('## Skill: skill2');
      expect(result).toContain('Skill 2 content');
    });
  });
});
