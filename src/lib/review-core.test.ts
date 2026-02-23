import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildBaseInstructions,
  runReviewPipeline,
  runReviewAgents,
  runUnifiedReviewAgent,
  displayReviewSummary,
  hasBlockingIssues,
  type FileWithDiff,
  type AgentReviewResult,
} from './review-core.js';
import type { DRSConfig } from './config.js';
import type { OpencodeClient } from '../opencode/client.js';

// Mock dependencies
vi.mock('./config.js', () => ({
  getAgentNames: vi.fn((config: DRSConfig) => config.review.agents || []),
  getDefaultSkills: vi.fn(() => []),
  normalizeAgentConfig: vi.fn((agents: Array<string | { name: string }>) =>
    agents.map((agent) => (typeof agent === 'string' ? { name: agent } : agent))
  ),
}));

vi.mock('./context-loader.js', () => ({
  buildReviewPrompt: vi.fn((agentType: string, baseInstructions: string) => {
    return `[PROMPT for ${agentType}]\n${baseInstructions}`;
  }),
}));

vi.mock('./issue-parser.js', () => ({
  parseReviewIssues: vi.fn((content: string, agentName?: string) => {
    try {
      const parsed = JSON.parse(content);
      if (parsed.issues && Array.isArray(parsed.issues)) {
        return parsed.issues.map((issue: any) => ({
          ...issue,
          agent: issue.agent || agentName || 'test',
        }));
      }
      return [];
    } catch {
      return [];
    }
  }),
}));

vi.mock('./review-parser.js', () => ({
  parseReviewOutput: vi.fn(async (_workingDir: string, _debug: boolean, response: string) => {
    // Try to parse the response as JSON
    try {
      return JSON.parse(response);
    } catch {
      return { issues: [] };
    }
  }),
}));

vi.mock('./comment-formatter.js', () => ({
  calculateSummary: vi.fn((filesReviewed: number, issues: any[]) => ({
    filesReviewed,
    issuesFound: issues.length,
    bySeverity: {
      CRITICAL: issues.filter((i) => i.severity === 'CRITICAL').length,
      HIGH: issues.filter((i) => i.severity === 'HIGH').length,
      MEDIUM: issues.filter((i) => i.severity === 'MEDIUM').length,
      LOW: issues.filter((i) => i.severity === 'LOW').length,
    },
    byCategory: {
      SECURITY: issues.filter((i) => i.category === 'SECURITY').length,
      QUALITY: issues.filter((i) => i.category === 'QUALITY').length,
      STYLE: issues.filter((i) => i.category === 'STYLE').length,
      PERFORMANCE: issues.filter((i) => i.category === 'PERFORMANCE').length,
      DOCUMENTATION: issues.filter((i) => i.category === 'DOCUMENTATION').length,
    },
  })),
}));

vi.mock('../opencode/agent-loader.js', () => ({
  loadReviewAgents: vi.fn(() => [
    { name: 'review/security', description: 'Security review' },
    { name: 'review/quality', description: 'Code quality review' },
    { name: 'review/unified-reviewer', description: 'Unified review' },
  ]),
}));

vi.mock('./comment-manager.js', () => ({
  createIssueFingerprint: vi.fn((issue: any) => {
    return `${issue.file}:${issue.line}:${issue.category}:${issue.severity}`;
  }),
}));

describe('review-core', () => {
  describe('buildBaseInstructions', () => {
    it('should build instructions with diff content', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '- old line\n+ new line',
        },
        {
          filename: 'src/utils.ts',
          patch: '+ added line',
        },
      ];

      const instructions = buildBaseInstructions('PR #123', files);

      expect(instructions).toContain('PR #123');
      expect(instructions).toContain('src/app.ts');
      expect(instructions).toContain('src/utils.ts');
      expect(instructions).toContain('- old line\n+ new line');
      expect(instructions).toContain('+ added line');
      expect(instructions).toContain('write_json_output');
      expect(instructions).toContain('Only report issues on lines that were actually changed');
    });

    it('should build instructions without diff content', () => {
      const files: FileWithDiff[] = [{ filename: 'src/app.ts' }, { filename: 'src/utils.ts' }];

      const instructions = buildBaseInstructions('MR !456', files, 'git diff HEAD~1');

      expect(instructions).toContain('MR !456');
      expect(instructions).toContain('src/app.ts');
      expect(instructions).toContain('src/utils.ts');
      expect(instructions).toContain('omitted due to size constraints');
      expect(instructions).toContain('Use the Read tool');
      expect(instructions).not.toContain('Bash tool');
      expect(instructions).not.toContain('git diff');
      expect(instructions).not.toContain('Diff Content');
    });

    it('should include compression summary when provided', () => {
      const files: FileWithDiff[] = [
        {
          filename: 'src/app.ts',
          patch: '+ new code',
        },
      ];

      const compressionSummary = '⚠️  Context was compressed due to size';
      const instructions = buildBaseInstructions('PR #123', files, undefined, compressionSummary);

      expect(instructions).toContain(compressionSummary);
    });

    it('should handle files with no patches', () => {
      const files: FileWithDiff[] = [
        { filename: 'src/file1.ts', patch: '+ change' },
        { filename: 'src/file2.ts' }, // no patch
      ];

      const instructions = buildBaseInstructions('PR #123', files);

      // Should only show file with patch in diff content
      expect(instructions).toContain('src/file1.ts');
      expect(instructions).toContain('src/file2.ts'); // should still be in file list
      expect(instructions).toMatch(/### src\/file1\.ts/);
    });

    it('should use default fallback command when not provided', () => {
      const files: FileWithDiff[] = [{ filename: 'src/app.ts' }];

      const instructions = buildBaseInstructions('PR #123', files);

      expect(instructions).toContain('omitted due to size constraints');
      expect(instructions).toContain('Use the Read tool');
    });
  });

  describe('runUnifiedReviewAgent', () => {
    let mockOpencode: OpencodeClient;
    let mockConfig: DRSConfig;

    beforeEach(() => {
      // Reset console.log spy
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      mockOpencode = {
        createSession: vi.fn(async () => ({ id: 'session-1' })),
        streamMessages: vi.fn(async function* () {
          yield {
            id: 'msg-1',
            role: 'assistant',
            content: JSON.stringify({
              issues: [
                {
                  category: 'SECURITY',
                  severity: 'HIGH',
                  title: 'Security issue',
                  file: 'src/app.ts',
                  line: 10,
                  problem: 'Found security issue',
                  solution: 'Fix it',
                },
              ],
            }),
            timestamp: new Date(),
          };
        }),
        closeSession: vi.fn(async () => {}),
      } as any;

      mockConfig = {
        review: {
          agents: ['unified-reviewer'],
          mode: 'unified',
        },
      } as DRSConfig;
    });

    it('should run unified review agent successfully', async () => {
      const result = await runUnifiedReviewAgent(
        mockOpencode,
        mockConfig,
        'Review these files',
        'PR #123',
        ['src/app.ts'],
        {},
        '/test/dir',
        false
      );

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].category).toBe('SECURITY');
      expect(result.issues[0].severity).toBe('HIGH');
      expect(result.filesReviewed).toBe(1);
      expect(result.agentResults).toHaveLength(1);
      expect(result.agentResults[0].success).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockOpencode.createSession).toHaveBeenCalledWith({
        agent: 'review/unified-reviewer',
        message: expect.stringContaining('Review these files'),
        context: {
          files: ['src/app.ts'],
        },
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockOpencode.closeSession).toHaveBeenCalledWith('session-1');
    });

    it('captures token usage and model metadata from assistant messages', async () => {
      mockOpencode.streamMessages = vi.fn(async function* () {
        yield {
          id: 'msg-usage-1',
          role: 'assistant',
          content: JSON.stringify({ issues: [] }),
          provider: 'opencode',
          model: 'glm-5-free',
          usage: {
            input: 1200,
            output: 100,
            cacheRead: 30,
            cacheWrite: 0,
            totalTokens: 1330,
            cost: 0.02,
          },
          timestamp: new Date(),
        };
      }) as any;

      const result = await runUnifiedReviewAgent(
        mockOpencode,
        mockConfig,
        'Review these files',
        'PR #123',
        ['src/app.ts'],
        {},
        '/test/dir',
        false
      );

      expect(result.usage).toEqual(
        expect.objectContaining({
          total: expect.objectContaining({
            input: 1200,
            output: 100,
            cacheRead: 30,
            cacheWrite: 0,
            totalTokens: 1330,
            cost: 0.02,
          }),
          agents: [
            expect.objectContaining({
              agentType: 'unified-reviewer',
              model: 'opencode/glm-5-free',
              turns: 1,
            }),
          ],
        })
      );
    });

    it('should handle agent failure gracefully', async () => {
      mockOpencode.createSession = vi.fn(async () => {
        throw new Error('Session creation failed');
      });

      const result = await runUnifiedReviewAgent(
        mockOpencode,
        mockConfig,
        'Review these files',
        'PR #123',
        ['src/app.ts'],
        {},
        '/test/dir',
        false
      );

      expect(result.issues).toHaveLength(0);
      expect(result.agentResults[0].success).toBe(false);
      expect(result.filesReviewed).toBe(1);
    });

    it('should handle invalid JSON output gracefully', async () => {
      mockOpencode.streamMessages = vi.fn(async function* () {
        yield {
          id: 'msg-1',
          role: 'assistant',
          content: 'This is not valid JSON',
          timestamp: new Date(),
        };
      }) as any;

      // parseReviewOutput mock returns { issues: [] } for invalid JSON
      // so this should succeed with no issues
      const result = await runUnifiedReviewAgent(
        mockOpencode,
        mockConfig,
        'Review these files',
        'PR #123',
        ['src/app.ts'],
        {},
        '/test/dir',
        false
      );

      expect(result.issues).toHaveLength(0);
      expect(result.agentResults[0].success).toBe(true);
    });

    it('should log debug information when debug=true', async () => {
      const logSpy = vi.spyOn(console, 'log');

      await runUnifiedReviewAgent(
        mockOpencode,
        mockConfig,
        'Review these files',
        'PR #123',
        ['src/app.ts'],
        {},
        '/test/dir',
        true
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('DEBUG'));
    });
  });

  describe('runReviewAgents', () => {
    let mockOpencode: OpencodeClient;
    let mockConfig: DRSConfig;

    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      mockOpencode = {
        createSession: vi.fn(async ({ agent }) => ({ id: `session-${agent}` })),
        streamMessages: vi.fn(async function* ({ agent }: any) {
          const agentType = agent?.split('/')[1] || 'test';
          yield {
            id: 'msg-1',
            role: 'assistant',
            content: JSON.stringify({
              issues: [
                {
                  category: agentType === 'security' ? 'SECURITY' : 'QUALITY',
                  severity: 'MEDIUM',
                  title: `${agentType} issue`,
                  file: 'src/app.ts',
                  line: 10,
                  problem: `Found ${agentType} issue`,
                  solution: 'Fix it',
                },
              ],
            }),
            timestamp: new Date(),
          };
        }),
        closeSession: vi.fn(async () => {}),
      } as any;

      mockConfig = {
        review: {
          agents: ['security', 'quality'],
          mode: 'multi-agent',
        },
      } as DRSConfig;
    });

    it('should run multiple agents successfully', async () => {
      const result = await runReviewAgents(
        mockOpencode,
        mockConfig,
        'Review these files',
        'PR #123',
        ['src/app.ts'],
        {},
        '/test/dir',
        false
      );

      expect(result.issues.length).toBeGreaterThanOrEqual(2);
      expect(result.agentResults).toHaveLength(2);
      expect(result.agentResults.every((r) => r.success)).toBe(true);
    });

    it('should continue if one agent fails', async () => {
      let callCount = 0;
      mockOpencode.createSession = vi.fn(async ({ agent }) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('First agent failed');
        }
        return { id: `session-${agent}`, agent, createdAt: new Date() };
      }) as any;

      const result = await runReviewAgents(
        mockOpencode,
        mockConfig,
        'Review these files',
        'PR #123',
        ['src/app.ts'],
        {},
        '/test/dir',
        false
      );

      expect(result.agentResults).toHaveLength(2);
      expect(result.agentResults.filter((r) => r.success)).toHaveLength(1);
      expect(result.agentResults.filter((r) => !r.success)).toHaveLength(1);
    });

    it('should throw error if all agents fail', async () => {
      mockOpencode.createSession = vi.fn(async () => {
        throw new Error('All agents failed');
      });

      await expect(
        runReviewAgents(
          mockOpencode,
          mockConfig,
          'Review these files',
          'PR #123',
          ['src/app.ts'],
          {},
          '/test/dir',
          false
        )
      ).rejects.toThrow('All review agents failed');
    });

    it('should handle empty agent list', async () => {
      mockConfig.review.agents = [];

      await expect(
        runReviewAgents(
          mockOpencode,
          mockConfig,
          'Review these files',
          'PR #123',
          ['src/app.ts'],
          {},
          '/test/dir',
          false
        )
      ).rejects.toThrow('All review agents failed');
    });

    it('should fail fast when config includes unknown agents', async () => {
      mockConfig.review.agents = ['security', 'unknown-agent'];

      await expect(
        runReviewAgents(
          mockOpencode,
          mockConfig,
          'Review these files',
          'PR #123',
          ['src/app.ts'],
          {},
          '/test/dir',
          false
        )
      ).rejects.toThrow('Unknown review agent(s) configured: unknown-agent');
    });
  });

  describe('runReviewPipeline', () => {
    let mockOpencode: OpencodeClient;
    let mockConfig: DRSConfig;

    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      mockOpencode = {
        createSession: vi.fn(async () => ({ id: 'session-1' })),
        streamMessages: vi.fn(async function* () {
          yield {
            id: 'msg-1',
            role: 'assistant',
            content: JSON.stringify({
              issues: [
                {
                  category: 'SECURITY',
                  severity: 'HIGH',
                  title: 'Issue',
                  file: 'src/app.ts',
                  line: 10,
                  problem: 'Problem',
                  solution: 'Solution',
                },
              ],
            }),
            timestamp: new Date(),
          };
        }),
        closeSession: vi.fn(async () => {}),
      } as any;
    });

    it('should run unified mode', async () => {
      mockConfig = {
        review: {
          agents: ['unified-reviewer'],
          mode: 'unified',
        },
      } as DRSConfig;

      const result = await runReviewPipeline(
        mockOpencode,
        mockConfig,
        'Base instructions',
        'PR #123',
        ['src/app.ts'],
        {},
        '/test/dir',
        false
      );

      expect(result.issues).toHaveLength(1);
      expect(result.agentResults[0].agentType).toBe('unified-reviewer');
    });

    it('should run multi-agent mode', async () => {
      mockConfig = {
        review: {
          agents: ['security', 'quality'],
          mode: 'multi-agent',
        },
      } as DRSConfig;

      const result = await runReviewPipeline(
        mockOpencode,
        mockConfig,
        'Base instructions',
        'PR #123',
        ['src/app.ts'],
        {},
        '/test/dir',
        false
      );

      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.agentResults.length).toBeGreaterThan(0);
    });

    it('should run hybrid mode and skip escalation for low severity', async () => {
      mockConfig = {
        review: {
          agents: ['unified-reviewer', 'security', 'quality'],
          mode: 'hybrid',
          unified: {
            severityThreshold: 'HIGH',
          },
        },
      } as DRSConfig;

      // Mock unified review returning only LOW severity
      mockOpencode.streamMessages = vi.fn(async function* () {
        yield {
          id: 'msg-1',
          role: 'assistant',
          content: JSON.stringify({
            issues: [
              {
                category: 'STYLE',
                severity: 'LOW',
                title: 'Style issue',
                file: 'src/app.ts',
                line: 10,
                problem: 'Minor style problem',
                solution: 'Fix style',
              },
            ],
          }),
          timestamp: new Date(),
        };
      }) as any;

      const result = await runReviewPipeline(
        mockOpencode,
        mockConfig,
        'Base instructions',
        'PR #123',
        ['src/app.ts'],
        {},
        '/test/dir',
        false
      );

      // Should only have unified result, no escalation
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe('LOW');
      expect(result.agentResults).toHaveLength(1);
    });

    it('should run hybrid mode and escalate for high severity', async () => {
      mockConfig = {
        review: {
          agents: ['unified-reviewer', 'security'],
          mode: 'hybrid',
          unified: {
            severityThreshold: 'HIGH',
          },
        },
      } as DRSConfig;

      let callCount = 0;
      mockOpencode.streamMessages = vi.fn(async function* () {
        callCount++;
        yield {
          id: 'msg-1',
          role: 'assistant',
          content: JSON.stringify({
            issues: [
              {
                category: callCount === 1 ? 'SECURITY' : 'QUALITY',
                severity: 'CRITICAL',
                title: `Issue ${callCount}`,
                file: 'src/app.ts',
                line: 10,
                problem: 'Critical problem',
                solution: 'Fix it',
              },
            ],
          }),
          timestamp: new Date(),
        };
      }) as any;

      const result = await runReviewPipeline(
        mockOpencode,
        mockConfig,
        'Base instructions',
        'PR #123',
        ['src/app.ts'],
        {},
        '/test/dir',
        false
      );

      // Should have both unified and escalated results
      expect(result.agentResults.length).toBeGreaterThan(1);
    });

    it('should default to multi-agent mode when mode is undefined', async () => {
      mockConfig = {
        review: {
          agents: ['security', 'quality'],
        },
      } as DRSConfig;

      const result = await runReviewPipeline(
        mockOpencode,
        mockConfig,
        'Base instructions',
        'PR #123',
        ['src/app.ts'],
        {},
        '/test/dir',
        false
      );

      expect(result.agentResults.length).toBeGreaterThan(0);
    });
  });

  describe('displayReviewSummary', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('should display summary with issues', () => {
      const result: AgentReviewResult = {
        issues: [
          {
            category: 'SECURITY',
            severity: 'CRITICAL',
            title: 'SQL Injection',
            file: 'src/app.ts',
            line: 10,
            problem: 'Problem',
            solution: 'Solution',
            agent: 'security',
          },
          {
            category: 'QUALITY',
            severity: 'MEDIUM',
            title: 'Code smell',
            file: 'src/utils.ts',
            line: 20,
            problem: 'Problem',
            solution: 'Solution',
            agent: 'quality',
          },
        ],
        summary: {
          filesReviewed: 2,
          issuesFound: 2,
          bySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 1, LOW: 0 },
          byCategory: { SECURITY: 1, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
        },
        filesReviewed: 2,
        agentResults: [],
      };

      displayReviewSummary(result);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Review Summary'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Files reviewed'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Issues found'));
    });

    it('should display summary with no issues', () => {
      const result: AgentReviewResult = {
        issues: [],
        summary: {
          filesReviewed: 5,
          issuesFound: 0,
          bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
          byCategory: { SECURITY: 0, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
        },
        filesReviewed: 5,
        agentResults: [],
      };

      displayReviewSummary(result);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Review Summary'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('5'));
    });

    it('should display change summary when available', () => {
      const result: AgentReviewResult = {
        issues: [],
        summary: {
          filesReviewed: 2,
          issuesFound: 0,
          bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
          byCategory: { SECURITY: 0, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
        },
        filesReviewed: 2,
        agentResults: [],
        changeSummary: {
          description: 'Added authentication',
          type: 'feature',
          complexity: 'medium',
          riskLevel: 'low',
          subsystems: ['auth', 'api'],
        },
      };

      displayReviewSummary(result);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Change Summary'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('authentication'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('feature'));
    });
  });

  describe('hasBlockingIssues', () => {
    it('should return true for CRITICAL issues', () => {
      const result = {
        summary: {
          filesReviewed: 1,
          issuesFound: 1,
          bySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0 },
          byCategory: { SECURITY: 1, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
        },
      };

      expect(hasBlockingIssues(result)).toBe(true);
    });

    it('should return true for HIGH issues', () => {
      const result = {
        summary: {
          filesReviewed: 1,
          issuesFound: 1,
          bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
          byCategory: { SECURITY: 0, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
        },
      };

      expect(hasBlockingIssues(result)).toBe(true);
    });

    it('should return false for MEDIUM and LOW issues only', () => {
      const result = {
        summary: {
          filesReviewed: 1,
          issuesFound: 2,
          bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 1 },
          byCategory: { SECURITY: 0, QUALITY: 1, STYLE: 1, PERFORMANCE: 0, DOCUMENTATION: 0 },
        },
      };

      expect(hasBlockingIssues(result)).toBe(false);
    });

    it('should return false for no issues', () => {
      const result = {
        summary: {
          filesReviewed: 1,
          issuesFound: 0,
          bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
          byCategory: { SECURITY: 0, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
        },
      };

      expect(hasBlockingIssues(result)).toBe(false);
    });
  });
});
