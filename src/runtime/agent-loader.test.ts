import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { getAgent, getReviewAgents, listAgents, loadReviewAgents } from './agent-loader.js';

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

  it('override preserves frontmatter fields: color, tools, hidden', () => {
    const projectRoot = createTempDir('drs-agent-frontmatter-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'security'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'security', 'agent.md'),
      [
        '---',
        'description: Themed agent',
        'color: "#FF5733"',
        'hidden: true',
        'tools:',
        '  Read: true',
        '  Grep: false',
        '---',
        '',
        'Custom prompt with all frontmatter fields.',
        '',
      ].join('\n')
    );

    const agents = loadReviewAgents(projectRoot);
    const security = agents.find((a) => a.name === 'review/security');

    expect(security?.color).toBe('#FF5733');
    expect(security?.hidden).toBe(true);
    expect(security?.tools).toEqual({ Read: true, Grep: false });
    expect(security?.prompt).toBe('Custom prompt with all frontmatter fields.');
  });

  it('agent.md without frontmatter is skipped with warning', () => {
    const projectRoot = createTempDir('drs-agent-no-frontmatter-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'security'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'security', 'agent.md'),
      'Just plain text, no frontmatter at all.\n'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agents = loadReviewAgents(projectRoot);

    // Override skipped — built-in security still loaded
    const security = agents.find((a) => a.name === 'review/security');
    expect(security?.path).toMatch(/\.pi[\\/]agents[\\/]review[\\/]security\.md$/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No frontmatter'));

    warnSpy.mockRestore();
  });
});

describe('getAgent / getReviewAgents / listAgents', () => {
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

  it('getAgent returns a specific agent by full name', () => {
    const agent = getAgent(process.cwd(), 'review/security');
    expect(agent).not.toBeNull();
    expect(agent?.name).toBe('review/security');
    expect(agent?.prompt).toContain('Security Vulnerability Assessment');
  });

  it('getAgent returns null for non-existent agent', () => {
    const agent = getAgent(process.cwd(), 'review/nonexistent');
    expect(agent).toBeNull();
  });

  it('getAgent returns override when present', () => {
    const projectRoot = createTempDir('drs-get-agent-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'security'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'security', 'agent.md'),
      '---\ndescription: Override via getAgent\n---\n\nOverride prompt\n'
    );

    const agent = getAgent(projectRoot, 'review/security');
    expect(agent?.description).toBe('Override via getAgent');
    expect(agent?.prompt).toBe('Override prompt');
  });

  it('getReviewAgents returns only review/ prefixed agents', () => {
    const agents = getReviewAgents(process.cwd());
    expect(agents.length).toBeGreaterThanOrEqual(5);
    expect(agents.every((a) => a.name.startsWith('review/'))).toBe(true);
  });

  it('getReviewAgents includes overrides', () => {
    const projectRoot = createTempDir('drs-get-review-agents-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'quality'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'quality', 'agent.md'),
      '---\ndescription: Custom quality\n---\n\nCustom quality prompt\n'
    );

    const agents = getReviewAgents(projectRoot);
    const quality = agents.find((a) => a.name === 'review/quality');
    expect(quality?.description).toBe('Custom quality');
  });

  it('listAgents returns all agent names as strings', () => {
    const names = listAgents(process.cwd());
    expect(names).toContain('review/security');
    expect(names).toContain('review/quality');
    expect(names).toContain('review/style');
    expect(names).toContain('review/performance');
    expect(names).toContain('review/documentation');
  });

  it('listAgents reflects overrides without duplication', () => {
    const projectRoot = createTempDir('drs-list-agents-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'security'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'security', 'agent.md'),
      '---\ndescription: Override\n---\n\nOverride prompt\n'
    );

    const names = listAgents(projectRoot);
    const securityCount = names.filter((n) => n === 'review/security').length;
    expect(securityCount).toBe(1);
  });
});

describe('new custom agent (not overriding built-in)', () => {
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

  it('discovers a brand new agent alongside built-ins', () => {
    const projectRoot = createTempDir('drs-new-agent-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'rails-reviewer'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'rails-reviewer', 'agent.md'),
      [
        '---',
        'description: Rails-specific code reviewer',
        'model: anthropic/claude-sonnet-4-5-20250929',
        'color: "#CC0000"',
        '---',
        '',
        'You are a Rails security and conventions reviewer.',
        'Focus on mass assignment, strong params, and N+1 queries.',
        '',
      ].join('\n')
    );

    const agents = loadReviewAgents(projectRoot);

    // New agent discovered
    const rails = agents.find((a) => a.name === 'review/rails-reviewer');
    expect(rails).toBeDefined();
    expect(rails?.description).toBe('Rails-specific code reviewer');
    expect(rails?.model).toBe('anthropic/claude-sonnet-4-5-20250929');
    expect(rails?.color).toBe('#CC0000');
    expect(rails?.prompt).toContain('mass assignment');
    expect(rails?.prompt).toContain('N+1 queries');

    // Built-ins still present
    expect(agents.some((a) => a.name === 'review/security')).toBe(true);
    expect(agents.some((a) => a.name === 'review/quality')).toBe(true);
  });

  it('new agent is accessible via getAgent', () => {
    const projectRoot = createTempDir('drs-new-get-agent-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'api-reviewer'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'api-reviewer', 'agent.md'),
      '---\ndescription: API contract reviewer\n---\n\nReview REST API contracts.\n'
    );

    const agent = getAgent(projectRoot, 'review/api-reviewer');
    expect(agent).not.toBeNull();
    expect(agent?.description).toBe('API contract reviewer');
    expect(agent?.prompt).toBe('Review REST API contracts.');
  });

  it('new agent appears in getReviewAgents and listAgents', () => {
    const projectRoot = createTempDir('drs-new-list-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'accessibility'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'accessibility', 'agent.md'),
      '---\ndescription: Accessibility reviewer\n---\n\nCheck WCAG compliance.\n'
    );

    const reviewAgents = getReviewAgents(projectRoot);
    expect(reviewAgents.some((a) => a.name === 'review/accessibility')).toBe(true);

    const names = listAgents(projectRoot);
    expect(names).toContain('review/accessibility');
  });

  it('new agent coexists with overrides of built-ins', () => {
    const projectRoot = createTempDir('drs-new-plus-override-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'security'), { recursive: true });
    mkdirSync(join(agentsDir, 'rails-reviewer'), { recursive: true });

    writeFileSync(
      join(agentsDir, 'security', 'agent.md'),
      '---\ndescription: Custom security\n---\n\nCustom security prompt\n'
    );
    writeFileSync(
      join(agentsDir, 'rails-reviewer', 'agent.md'),
      '---\ndescription: Rails reviewer\n---\n\nRails review prompt\n'
    );

    const agents = loadReviewAgents(projectRoot);

    // Override replaces built-in
    const security = agents.find((a) => a.name === 'review/security');
    expect(security?.prompt).toBe('Custom security prompt');

    // New agent added
    const rails = agents.find((a) => a.name === 'review/rails-reviewer');
    expect(rails?.prompt).toBe('Rails review prompt');

    // Other built-ins still present
    expect(agents.some((a) => a.name === 'review/quality')).toBe(true);
    expect(agents.some((a) => a.name === 'review/style')).toBe(true);
  });
});
