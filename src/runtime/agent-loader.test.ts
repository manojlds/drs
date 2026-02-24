import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { loadReviewAgents } from './agent-loader.js';

function createConfig(agentsPath: string): DRSConfig {
  return {
    review: {
      paths: {
        agents: agentsPath,
      },
    },
  } as unknown as DRSConfig;
}

describe('agent-loader path resolution', () => {
  const tempDirs: string[] = [];

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads override agents from configured repo-relative path', () => {
    const projectRoot = createTempDir('drs-agent-loader-');
    const customAgentsRoot = join(projectRoot, 'config', 'agents');
    const customAgentPath = join(customAgentsRoot, 'security', 'agent.md');

    mkdirSync(join(customAgentsRoot, 'security'), { recursive: true });
    writeFileSync(
      customAgentPath,
      `---\ndescription: Custom security override\nmodel: anthropic/custom-security\n---\n\nCustom security instructions\n`
    );

    const agents = loadReviewAgents(projectRoot, createConfig('config/agents'));

    const securityAgent = agents.find((agent) => agent.name === 'review/security');
    expect(securityAgent).toBeDefined();
    expect(securityAgent?.description).toBe('Custom security override');
    expect(securityAgent?.path).toBe(resolve(customAgentPath));

    expect(agents.some((agent) => agent.name === 'review/quality')).toBe(true);
  });

  it('custom agent override replaces built-in prompt and model', () => {
    const projectRoot = createTempDir('drs-agent-override-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'security'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'security', 'agent.md'),
      [
        '---',
        'description: Project-specific security reviewer',
        'model: openai/gpt-4o',
        '---',
        '',
        'You are a security reviewer for our Rails application.',
        'Focus on mass assignment and CSRF vulnerabilities.',
        '',
      ].join('\n')
    );

    const agents = loadReviewAgents(projectRoot);

    const securityAgent = agents.find((a) => a.name === 'review/security');
    expect(securityAgent).toBeDefined();
    expect(securityAgent?.description).toBe('Project-specific security reviewer');
    expect(securityAgent?.model).toBe('openai/gpt-4o');
    expect(securityAgent?.prompt).toContain('Rails application');
    expect(securityAgent?.prompt).toContain('CSRF vulnerabilities');
    // Must NOT contain the built-in prompt
    expect(securityAgent?.prompt).not.toContain('Security Vulnerability Assessment');

    // Other built-in agents still loaded
    const qualityAgent = agents.find((a) => a.name === 'review/quality');
    expect(qualityAgent).toBeDefined();
    expect(qualityAgent?.path).toMatch(/\.pi[\\/]agents[\\/]review[\\/]quality\.md$/);
  });

  it('multiple custom agents override their respective built-ins', () => {
    const projectRoot = createTempDir('drs-agent-multi-override-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'security'), { recursive: true });
    mkdirSync(join(agentsDir, 'style'), { recursive: true });

    writeFileSync(
      join(agentsDir, 'security', 'agent.md'),
      '---\ndescription: Custom security\n---\n\nCustom security prompt\n'
    );
    writeFileSync(
      join(agentsDir, 'style', 'agent.md'),
      '---\ndescription: Custom style\n---\n\nCustom style prompt\n'
    );

    const agents = loadReviewAgents(projectRoot);

    const security = agents.find((a) => a.name === 'review/security');
    const style = agents.find((a) => a.name === 'review/style');
    const quality = agents.find((a) => a.name === 'review/quality');

    expect(security?.prompt).toBe('Custom security prompt');
    expect(style?.prompt).toBe('Custom style prompt');
    // quality remains built-in
    expect(quality?.path).toMatch(/\.pi[\\/]agents[\\/]review[\\/]quality\.md$/);
  });

  it('loads built-in Pi-native review agents and keeps all core categories', () => {
    const agents = loadReviewAgents(process.cwd());
    const reviewAgentNames = new Set(
      agents.filter((agent) => agent.name.startsWith('review/')).map((agent) => agent.name)
    );

    expect(reviewAgentNames.has('review/security')).toBe(true);
    expect(reviewAgentNames.has('review/quality')).toBe(true);
    expect(reviewAgentNames.has('review/style')).toBe(true);
    expect(reviewAgentNames.has('review/performance')).toBe(true);
    expect(reviewAgentNames.has('review/documentation')).toBe(true);

    const securityAgent = agents.find((agent) => agent.name === 'review/security');
    expect(securityAgent?.prompt).toContain('Security Vulnerability Assessment');
    expect(securityAgent?.path).toMatch(/\.pi[\\/]agents[\\/]review[\\/]security\.md$/);
  });

  it('throws actionable error when configured agent path is invalid', () => {
    const projectRoot = createTempDir('drs-agent-loader-invalid-');

    expect(() => loadReviewAgents(projectRoot, createConfig('missing/agents'))).toThrow(
      'review.paths.agents'
    );
  });
});
