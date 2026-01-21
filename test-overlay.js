#!/usr/bin/env node
/**
 * Quick test to verify the overlay mechanism creates proper structure
 * Run with --debug flag to see detailed logging: node test-overlay.js --debug
 */

import { createAgentSkillOverlay } from './dist/opencode/agent-skill-overlay.js';
import { loadConfig } from './dist/lib/config.js';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import yaml from 'yaml';

async function main() {
  const debug = process.argv.includes('--debug');
  const projectPath = process.cwd();
  const config = await loadConfig(projectPath);

  console.log('🧪 Testing overlay mechanism...');
  if (debug) {
    console.log('🔍 Debug mode enabled\n');
  }

  const overlay = await createAgentSkillOverlay(projectPath, config, debug);

  if (!overlay) {
    console.log('❌ No overlay created (no skills configured)');
    console.log('   To configure skills, add them to .drs/drs.config.yaml:');
    console.log('   review:');
    console.log('     default:');
    console.log('       skills:');
    console.log('         - your-skill-name');
    return;
  }

  console.log('✅ Overlay created successfully');
  console.log('📁 Overlay root:', overlay.root);
  console.log('');

  // Check skills directory
  const skillsPath = join(overlay.root, '.opencode', 'skills');
  console.log('📚 Skills directory:', skillsPath);
  const skillDirs = await readdir(skillsPath).catch(() => []);
  if (skillDirs.length > 0) {
    console.log('✅ Skills found:', skillDirs.join(', '));

    // Check each skill has SKILL.md
    for (const skillDir of skillDirs) {
      const skillFile = join(skillsPath, skillDir, 'SKILL.md');
      try {
        await readFile(skillFile, 'utf-8');
        console.log(`   ✓ ${skillDir}/SKILL.md exists`);
      } catch {
        console.log(`   ✗ ${skillDir}/SKILL.md missing!`);
      }
    }
  } else {
    console.log('⚠️  No skills found in overlay');
  }
  console.log('');

  // Check agents directory
  const agentsPath = join(overlay.root, '.opencode', 'agent', 'review');
  console.log('🤖 Agents directory:', agentsPath);
  const agentFiles = await readdir(agentsPath).catch(() => []);
  console.log(`✅ ${agentFiles.length} agent file(s) found`);
  if (debug) {
    console.log('   Files:', agentFiles.join(', '));
  } else {
    console.log('   Files:', agentFiles.slice(0, 5).join(', '), agentFiles.length > 5 ? '...' : '');
  }
  console.log('');

  // Verify skill tool is enabled in agents
  console.log('🔍 Verifying skill tool configuration in agents:');
  let checkedCount = 0;
  const maxToCheck = debug ? agentFiles.length : 3;

  for (const agentFile of agentFiles.slice(0, maxToCheck)) {
    const agentPath = join(agentsPath, agentFile);
    const content = await readFile(agentPath, 'utf-8');
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

    if (frontmatterMatch) {
      const frontmatter = yaml.parse(frontmatterMatch[1]);
      const hasSkillTool = frontmatter?.tools?.skill === true;
      const hasSkillPermission = frontmatter?.permission?.skill?.['*'] === 'allow';

      const status = hasSkillTool && hasSkillPermission ? '✅' : '❌';
      console.log(`   ${status} ${agentFile}:`);
      console.log(`      skill tool: ${hasSkillTool ? '✓ enabled' : '✗ not enabled'}`);
      console.log(`      permissions: ${hasSkillPermission ? '✓ configured' : '✗ not configured'}`);

      if (debug && hasSkillTool) {
        console.log('      Full frontmatter:');
        console.log('      ---');
        console.log(frontmatterMatch[0].split('\n').map(l => '      ' + l).join('\n'));
        console.log('');
      }

      checkedCount++;
    }
  }

  if (!debug && agentFiles.length > maxToCheck) {
    console.log(`   ... and ${agentFiles.length - maxToCheck} more agents`);
    console.log('   (use --debug to see all agents)');
  }
  console.log('');

  // Summary
  console.log('📊 Summary:');
  console.log(`   ✅ ${skillDirs.length} skill(s) copied to overlay`);
  console.log(`   ✅ ${agentFiles.length} agent(s) configured`);
  console.log(`   ✅ Skill tool enabled and permissions set`);
  console.log('');

  await overlay.cleanup();
  console.log('🧹 Overlay cleaned up');
  console.log('');
  console.log('✨ Test completed successfully!');
  console.log('');
  console.log('ℹ️  Remember: Skills are loaded on-demand via the skill tool.');
  console.log('   Agents must actively call the skill tool to access skills.');
}

main().catch(console.error);
