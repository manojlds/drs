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

  it('throws actionable error when configured agent path is invalid', () => {
    const projectRoot = createTempDir('drs-agent-loader-invalid-');

    expect(() => loadReviewAgents(projectRoot, createConfig('missing/agents'))).toThrow(
      'review.paths.agents'
    );
  });
});
