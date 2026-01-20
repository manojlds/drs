#!/usr/bin/env node
/**
 * Quick test to verify the overlay mechanism creates proper structure
 */

import { createAgentSkillOverlay } from './dist/opencode/agent-skill-overlay.js';
import { loadConfig } from './dist/lib/config.js';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

async function main() {
  const projectPath = process.cwd();
  const config = await loadConfig(projectPath);

  console.log('Creating overlay...');
  const overlay = await createAgentSkillOverlay(projectPath, config);

  if (!overlay) {
    console.log('No overlay created (no skills configured)');
    return;
  }

  console.log('Overlay root:', overlay.root);
  console.log('');

  // Check skills directory
  const skillsPath = join(overlay.root, '.opencode', 'skills');
  console.log('Skills directory:', skillsPath);
  const skillDirs = await readdir(skillsPath).catch(() => []);
  console.log('Skill directories found:', skillDirs);
  console.log('');

  // Check agents directory
  const agentsPath = join(overlay.root, '.opencode', 'agent', 'review');
  console.log('Agents directory:', agentsPath);
  const agentFiles = await readdir(agentsPath).catch(() => []);
  console.log('Agent files found:', agentFiles.slice(0, 5), '...');
  console.log('');

  // Read one agent to see frontmatter
  if (agentFiles.length > 0) {
    const agentPath = join(agentsPath, agentFiles[0]);
    const content = await readFile(agentPath, 'utf-8');
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      console.log(`Sample agent frontmatter (${agentFiles[0]}):`);
      console.log(frontmatterMatch[0]);
    }
  }

  await overlay.cleanup();
  console.log('');
  console.log('Overlay cleaned up');
}

main().catch(console.error);
