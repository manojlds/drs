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
    const customAgentPath = join(customAgentsRoot, 'review', 'unified-reviewer', 'agent.md');

    mkdirSync(join(customAgentsRoot, 'review', 'unified-reviewer'), { recursive: true });
    writeFileSync(
      customAgentPath,
      `---\ndescription: Custom unified override\nmodel: anthropic/custom-unified\n---\n\nCustom unified instructions\n`
    );

    const agents = loadAgents(projectRoot, createConfig('config/agents'));

    const unifiedAgent = agents.find((agent) => agent.id === 'review/unified-reviewer');
    expect(unifiedAgent).toBeDefined();
    expect(unifiedAgent?.description).toBe('Custom unified override');
    expect(unifiedAgent?.path).toBe(resolve(customAgentPath));

    expect(agents.some((agent) => agent.id === 'review/unified-reviewer')).toBe(true);
  });

  it('custom agent override replaces built-in prompt and model', () => {
    const projectRoot = createTempDir('drs-agent-override-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'unified-reviewer'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'unified-reviewer', 'agent.md'),
      [
        '---',
        'description: Project-specific unified reviewer',
        'model: openai/gpt-4o-mini',
        '---',
        '',
        'You are a unified reviewer for our Rails application.',
        'Focus on correctness and security issues.',
        '',
      ].join('\n')
    );

    const agents = loadAgents(projectRoot);

    const unifiedAgent = agents.find((a) => a.id === 'review/unified-reviewer');
    expect(unifiedAgent).toBeDefined();
    expect(unifiedAgent?.description).toBe('Project-specific unified reviewer');
    expect(unifiedAgent?.model).toBe('openai/gpt-4o-mini');
    expect(unifiedAgent?.prompt).toContain('Rails application');
    expect(unifiedAgent?.prompt).toContain('correctness and security');
    // Must NOT contain the built-in prompt
    expect(unifiedAgent?.prompt).not.toContain('Security Vulnerability Assessment');
  });

  it('supports custom review agents alongside packaged unified reviewer', () => {
    const projectRoot = createTempDir('drs-agent-multi-override-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'sql-reviewer'), { recursive: true });
    mkdirSync(join(agentsDir, 'review', 'api-reviewer'), { recursive: true });

    writeFileSync(
      join(agentsDir, 'review', 'sql-reviewer', 'agent.md'),
      '---\ndescription: Custom SQL reviewer\n---\n\nCustom SQL prompt\n'
    );
    writeFileSync(
      join(agentsDir, 'review', 'api-reviewer', 'agent.md'),
      '---\ndescription: Custom API reviewer\n---\n\nCustom API prompt\n'
    );

    const agents = loadAgents(projectRoot);

    const sqlReviewer = agents.find((a) => a.id === 'review/sql-reviewer');
    const apiReviewer = agents.find((a) => a.id === 'review/api-reviewer');
    const unified = agents.find((a) => a.id === 'review/unified-reviewer');

    expect(sqlReviewer?.prompt).toBe('Custom SQL prompt');
    expect(apiReviewer?.prompt).toBe('Custom API prompt');
    expect(unified?.path).toMatch(/\.pi[\\/]agents[\\/]review[\\/]unified-reviewer\.md$/);
  });

  it('loads packaged unified review agent', () => {
    const agents = loadAgents(process.cwd());
    const reviewAgentNames = new Set(
      agents.filter((agent) => agent.namespace === 'review').map((agent) => agent.id)
    );

    expect(reviewAgentNames.has('review/unified-reviewer')).toBe(true);

    const unifiedAgent = agents.find((agent) => agent.id === 'review/unified-reviewer');
    expect(unifiedAgent?.prompt).toContain('unified code review agent');
    expect(unifiedAgent?.path).toMatch(/\.pi[\\/]agents[\\/]review[\\/]unified-reviewer\.md$/);
  });

  it('loads packaged visual explainer agent', () => {
    const agents = loadAgents(process.cwd());
    const visualAgent = agents.find((agent) => agent.id === 'visual/pr-explainer');

    expect(visualAgent?.namespace).toBe('visual');
    expect(visualAgent?.prompt).toContain('self-contained HTML page');
    expect(visualAgent?.skills).toBeUndefined();
    expect(visualAgent?.tools?.Bash).toBe(false);
    expect(visualAgent?.tools?.git_diff).toBe(true);
  });

  it('loads packaged OKF wiki maintainer agent', () => {
    const agents = loadAgents(process.cwd());
    const wikiAgent = agents.find((agent) => agent.id === 'task/okf-wiki-maintainer');

    expect(wikiAgent?.prompt).toContain('Open Knowledge Format (OKF) v0.1 bundle');
    expect(wikiAgent?.prompt).toContain(
      'Filesystem permissions enforce writes below the bundle root'
    );
    expect(wikiAgent?.tools?.Edit).toBe(true);
    expect(wikiAgent?.tools?.Write).toBe(true);
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

    mkdirSync(join(agentsDir, 'review', 'unified-reviewer'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'unified-reviewer', 'agent.md'),
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
    const unified = agents.find((a) => a.id === 'review/unified-reviewer');

    expect(unified?.color).toBe('#FF5733');
    expect(unified?.hidden).toBe(true);
    expect(unified?.tools).toEqual({ Read: true, Grep: false });
    expect(unified?.skills).toEqual(['secure-code-review', 'dependency-audit']);
    expect(unified?.prompt).toBe('Custom prompt with all frontmatter fields.');
  });

  it('agent.md without frontmatter is skipped with warning', () => {
    const projectRoot = createTempDir('drs-agent-no-frontmatter-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'unified-reviewer'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'unified-reviewer', 'agent.md'),
      'Just plain text, no frontmatter at all.\n'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agents = loadAgents(projectRoot);

    // Override skipped — built-in unified reviewer still loaded
    const unified = agents.find((a) => a.id === 'review/unified-reviewer');
    expect(unified?.path).toMatch(/\.pi[\\/]agents[\\/]review[\\/]unified-reviewer\.md$/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No frontmatter'));

    warnSpy.mockRestore();
  });

  it('fails flat project agents with migration guidance', () => {
    const projectRoot = createTempDir('drs-agent-flat-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'unified-reviewer'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'unified-reviewer', 'agent.md'),
      '---\ndescription: Flat security\n---\n\nFlat prompt\n'
    );

    expect(() => loadAgents(projectRoot)).toThrow('.drs/agents/<namespace>/<name>/agent.md');
    expect(() => loadAgents(projectRoot)).toThrow('.drs/agents/review/unified-reviewer/agent.md');
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
    const agent = getAgent(process.cwd(), 'review/unified-reviewer');
    expect(agent).not.toBeNull();
    expect(agent?.id).toBe('review/unified-reviewer');
    expect(agent?.prompt).toContain('unified code review agent');
  });

  it('getAgent returns null for non-existent agent', () => {
    const agent = getAgent(process.cwd(), 'review/nonexistent');
    expect(agent).toBeNull();
  });

  it('getAgent returns override when present', () => {
    const projectRoot = createTempDir('drs-get-agent-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'unified-reviewer'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'unified-reviewer', 'agent.md'),
      '---\ndescription: Override via getAgent\n---\n\nOverride prompt\n'
    );

    const agent = getAgent(projectRoot, 'review/unified-reviewer');
    expect(agent?.description).toBe('Override via getAgent');
    expect(agent?.prompt).toBe('Override prompt');
  });

  it('getAgentsByNamespace returns only review agents', () => {
    const agents = getAgentsByNamespace(process.cwd(), 'review');
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.every((a) => a.namespace === 'review')).toBe(true);
  });

  it('getAgentsByNamespace includes overrides', () => {
    const projectRoot = createTempDir('drs-get-review-agents-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'unified-reviewer'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'unified-reviewer', 'agent.md'),
      '---\ndescription: Custom unified\n---\n\nCustom unified prompt\n'
    );

    const agents = getAgentsByNamespace(projectRoot, 'review');
    const unified = agents.find((a) => a.id === 'review/unified-reviewer');
    expect(unified?.description).toBe('Custom unified');
  });

  it('listAgents returns all agent names as strings', () => {
    const names = listAgents(process.cwd());
    expect(names).toContain('review/unified-reviewer');
  });

  it('listAgents reflects overrides without duplication', () => {
    const projectRoot = createTempDir('drs-list-agents-');
    const agentsDir = join(projectRoot, '.drs', 'agents');

    mkdirSync(join(agentsDir, 'review', 'unified-reviewer'), { recursive: true });
    writeFileSync(
      join(agentsDir, 'review', 'unified-reviewer', 'agent.md'),
      '---\ndescription: Override\n---\n\nOverride prompt\n'
    );

    const names = listAgents(projectRoot);
    const unifiedCount = names.filter((n) => n === 'review/unified-reviewer').length;
    expect(unifiedCount).toBe(1);
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

    // Packaged unified reviewer still present
    expect(agents.some((a) => a.id === 'review/unified-reviewer')).toBe(true);
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

    mkdirSync(join(agentsDir, 'review', 'unified-reviewer'), { recursive: true });
    mkdirSync(join(agentsDir, 'review', 'rails-reviewer'), { recursive: true });

    writeFileSync(
      join(agentsDir, 'review', 'unified-reviewer', 'agent.md'),
      '---\ndescription: Custom unified\n---\n\nCustom unified prompt\n'
    );
    writeFileSync(
      join(agentsDir, 'review', 'rails-reviewer', 'agent.md'),
      '---\ndescription: Rails reviewer\n---\n\nRails review prompt\n'
    );

    const agents = loadAgents(projectRoot);

    // Override replaces built-in
    const unified = agents.find((a) => a.id === 'review/unified-reviewer');
    expect(unified?.prompt).toBe('Custom unified prompt');

    // New agent added
    const rails = agents.find((a) => a.id === 'review/rails-reviewer');
    expect(rails?.prompt).toBe('Rails review prompt');

    // Packaged unified reviewer can be overridden while custom agents coexist
    expect(agents.some((a) => a.id === 'review/unified-reviewer')).toBe(true);
  });
});
