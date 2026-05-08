import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { getAgent, getAgentsByNamespace, listAgents, loadAgents } from './agent-loader.js';

function createConfig(agentsPath: string): DRSConfig {
  return {
    agents: {
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
    const customAgentPath = join(customAgentsRoot, 'review', 'security', 'agent.md');

    mkdirSync(join(customAgentsRoot, 'review', 'security'), { recursive: true });
    writeFileSync(
      customAgentPath,
      `---\ndescription: Custom security override\nmodel: anthropic/custom-security\n---\n\nCustom security instructions\n`
    );

    const agents = loadAgents(projectRoot, createConfig('config/agents'));

    const securityAgent = agents.find((agent) => agent.id === 'review/security');
    expect(securityAgent).toBeDefined();
    expect(securityAgent?.description).toBe('Custom security override');
    expect(securityAgent?.path).toBe(resolve(customAgentPath));

    expect(agents.some((agent) => agent.id === 'review/quality')).toBe(true);
  });

  it('custom agent override replaces built-in prompt and model', () => {
    const projectRoot = createTempDir('drs-agent-override-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'security'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'security', 'agent.md'),
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

    const agents = loadAgents(projectRoot);

    const securityAgent = agents.find((a) => a.id === 'review/security');
    expect(securityAgent).toBeDefined();
    expect(securityAgent?.description).toBe('Project-specific security reviewer');
    expect(securityAgent?.model).toBe('openai/gpt-4o');
    expect(securityAgent?.prompt).toContain('Rails application');
    expect(securityAgent?.prompt).toContain('CSRF vulnerabilities');
    // Must NOT contain the built-in prompt
    expect(securityAgent?.prompt).not.toContain('Security Vulnerability Assessment');

    // Other built-in agents still loaded
    const qualityAgent = agents.find((a) => a.id === 'review/quality');
    expect(qualityAgent).toBeDefined();
    expect(qualityAgent?.path).toMatch(/\.pi[\\/]agents[\\/]review[\\/]quality\.md$/);
  });

  it('multiple custom agents override their respective built-ins', () => {
    const projectRoot = createTempDir('drs-agent-multi-override-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'security'), { recursive: true });
    mkdirSync(join(agentsDir, 'review', 'style'), { recursive: true });

    writeFileSync(
      join(agentsDir, 'review', 'security', 'agent.md'),
      '---\ndescription: Custom security\n---\n\nCustom security prompt\n'
    );
    writeFileSync(
      join(agentsDir, 'review', 'style', 'agent.md'),
      '---\ndescription: Custom style\n---\n\nCustom style prompt\n'
    );

    const agents = loadAgents(projectRoot);

    const security = agents.find((a) => a.id === 'review/security');
    const style = agents.find((a) => a.id === 'review/style');
    const quality = agents.find((a) => a.id === 'review/quality');

    expect(security?.prompt).toBe('Custom security prompt');
    expect(style?.prompt).toBe('Custom style prompt');
    // quality remains built-in
    expect(quality?.path).toMatch(/\.pi[\\/]agents[\\/]review[\\/]quality\.md$/);
  });

  it('loads built-in Pi-native review agents and keeps all core categories', () => {
    const agents = loadAgents(process.cwd());
    const reviewAgentNames = new Set(
      agents.filter((agent) => agent.namespace === 'review').map((agent) => agent.id)
    );

    expect(reviewAgentNames.has('review/security')).toBe(true);
    expect(reviewAgentNames.has('review/quality')).toBe(true);
    expect(reviewAgentNames.has('review/style')).toBe(true);
    expect(reviewAgentNames.has('review/performance')).toBe(true);
    expect(reviewAgentNames.has('review/documentation')).toBe(true);

    const securityAgent = agents.find((agent) => agent.id === 'review/security');
    expect(securityAgent?.prompt).toContain('Security Vulnerability Assessment');
    expect(securityAgent?.path).toMatch(/\.pi[\\/]agents[\\/]review[\\/]security\.md$/);
  });

  it('throws actionable error when configured agent path is invalid', () => {
    const projectRoot = createTempDir('drs-agent-loader-invalid-');

    expect(() => loadAgents(projectRoot, createConfig('missing/agents'))).toThrow(
      'agents.paths.agents'
    );
  });

  it('override preserves frontmatter fields: color, tools, hidden', () => {
    const projectRoot = createTempDir('drs-agent-frontmatter-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'security'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'security', 'agent.md'),
      [
        '---',
        'description: Themed agent',
        'color: "#FF5733"',
        'hidden: true',
        'tools:',
        '  Read: true',
        '  Grep: false',
        'skills:',
        '  - secure-code-review',
        '  - dependency-audit',
        '---',
        '',
        'Custom prompt with all frontmatter fields.',
        '',
      ].join('\n')
    );

    const agents = loadAgents(projectRoot);
    const security = agents.find((a) => a.id === 'review/security');

    expect(security?.color).toBe('#FF5733');
    expect(security?.hidden).toBe(true);
    expect(security?.tools).toEqual({ Read: true, Grep: false });
    expect(security?.skills).toEqual(['secure-code-review', 'dependency-audit']);
    expect(security?.prompt).toBe('Custom prompt with all frontmatter fields.');
  });

  it('agent.md without frontmatter is skipped with warning', () => {
    const projectRoot = createTempDir('drs-agent-no-frontmatter-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'security'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'security', 'agent.md'),
      'Just plain text, no frontmatter at all.\n'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agents = loadAgents(projectRoot);

    // Override skipped — built-in security still loaded
    const security = agents.find((a) => a.id === 'review/security');
    expect(security?.path).toMatch(/\.pi[\\/]agents[\\/]review[\\/]security\.md$/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No frontmatter'));

    warnSpy.mockRestore();
  });

  it('skips flat project agents with migration guidance', () => {
    const projectRoot = createTempDir('drs-agent-flat-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'security'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'security', 'agent.md'),
      '---\ndescription: Flat security\n---\n\nFlat prompt\n'
    );

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const agents = loadAgents(projectRoot);

    expect(agents.some((agent) => agent.id === 'security')).toBe(false);
    const parseError = errorSpy.mock.calls[0]?.[1];
    expect(parseError).toBeInstanceOf(Error);
    expect(String((parseError as Error).message)).toContain(
      '.drs/agents/<namespace>/<name>/agent.md'
    );
    expect(String((parseError as Error).message)).toContain('.drs/agents/review/security/agent.md');

    errorSpy.mockRestore();
  });
});

describe('getAgent / getAgentsByNamespace / listAgents', () => {
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
    expect(agent?.id).toBe('review/security');
    expect(agent?.prompt).toContain('Security Vulnerability Assessment');
  });

  it('getAgent returns null for non-existent agent', () => {
    const agent = getAgent(process.cwd(), 'review/nonexistent');
    expect(agent).toBeNull();
  });

  it('getAgent returns override when present', () => {
    const projectRoot = createTempDir('drs-get-agent-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'security'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'security', 'agent.md'),
      '---\ndescription: Override via getAgent\n---\n\nOverride prompt\n'
    );

    const agent = getAgent(projectRoot, 'review/security');
    expect(agent?.description).toBe('Override via getAgent');
    expect(agent?.prompt).toBe('Override prompt');
  });

  it('getAgentsByNamespace returns only review agents', () => {
    const agents = getAgentsByNamespace(process.cwd(), 'review');
    expect(agents.length).toBeGreaterThanOrEqual(5);
    expect(agents.every((a) => a.namespace === 'review')).toBe(true);
  });

  it('getAgentsByNamespace includes overrides', () => {
    const projectRoot = createTempDir('drs-get-review-agents-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'quality'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'quality', 'agent.md'),
      '---\ndescription: Custom quality\n---\n\nCustom quality prompt\n'
    );

    const agents = getAgentsByNamespace(projectRoot, 'review');
    const quality = agents.find((a) => a.id === 'review/quality');
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

    mkdirSync(join(agentsDir, 'review', 'security'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'security', 'agent.md'),
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

    mkdirSync(join(agentsDir, 'review', 'rails-reviewer'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'rails-reviewer', 'agent.md'),
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

    const agents = loadAgents(projectRoot);

    // New agent discovered
    const rails = agents.find((a) => a.id === 'review/rails-reviewer');
    expect(rails).toBeDefined();
    expect(rails?.description).toBe('Rails-specific code reviewer');
    expect(rails?.model).toBe('anthropic/claude-sonnet-4-5-20250929');
    expect(rails?.color).toBe('#CC0000');
    expect(rails?.prompt).toContain('mass assignment');
    expect(rails?.prompt).toContain('N+1 queries');

    // Built-ins still present
    expect(agents.some((a) => a.id === 'review/security')).toBe(true);
    expect(agents.some((a) => a.id === 'review/quality')).toBe(true);
  });

  it('new agent is accessible via getAgent', () => {
    const projectRoot = createTempDir('drs-new-get-agent-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'api-reviewer'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'api-reviewer', 'agent.md'),
      '---\ndescription: API contract reviewer\n---\n\nReview REST API contracts.\n'
    );

    const agent = getAgent(projectRoot, 'review/api-reviewer');
    expect(agent).not.toBeNull();
    expect(agent?.description).toBe('API contract reviewer');
    expect(agent?.prompt).toBe('Review REST API contracts.');
  });

  it('new agent appears in getAgentsByNamespace and listAgents', () => {
    const projectRoot = createTempDir('drs-new-list-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'accessibility'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'accessibility', 'agent.md'),
      '---\ndescription: Accessibility reviewer\n---\n\nCheck WCAG compliance.\n'
    );

    const reviewAgents = getAgentsByNamespace(projectRoot, 'review');
    expect(reviewAgents.some((a) => a.id === 'review/accessibility')).toBe(true);

    const names = listAgents(projectRoot);
    expect(names).toContain('review/accessibility');
  });

  it('new agent coexists with overrides of built-ins', () => {
    const projectRoot = createTempDir('drs-new-plus-override-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'security'), { recursive: true });
    mkdirSync(join(agentsDir, 'review', 'rails-reviewer'), { recursive: true });

    writeFileSync(
      join(agentsDir, 'review', 'security', 'agent.md'),
      '---\ndescription: Custom security\n---\n\nCustom security prompt\n'
    );
    writeFileSync(
      join(agentsDir, 'review', 'rails-reviewer', 'agent.md'),
      '---\ndescription: Rails reviewer\n---\n\nRails review prompt\n'
    );

    const agents = loadAgents(projectRoot);

    // Override replaces built-in
    const security = agents.find((a) => a.id === 'review/security');
    expect(security?.prompt).toBe('Custom security prompt');

    // New agent added
    const rails = agents.find((a) => a.id === 'review/rails-reviewer');
    expect(rails?.prompt).toBe('Rails review prompt');

    // Other built-ins still present
    expect(agents.some((a) => a.id === 'review/quality')).toBe(true);
    expect(agents.some((a) => a.id === 'review/style')).toBe(true);
  });
});
