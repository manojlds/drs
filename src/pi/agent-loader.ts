import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, relative } from 'path';
import * as yaml from 'yaml';
import { builtInAgentPath } from './paths.js';

export interface AgentDefinition {
  name: string;
  path: string;
  description: string;
  color?: string;
  model?: string;
  tools?: Record<string, boolean>;
  hidden?: boolean;
}

/**
 * Load review agents from a project directory
 *
 * Priority order:
 * 1. Project .drs/agents/<name>/agent.md (DRS-specific overrides/custom)
 * 2. Built-in agents shipped with DRS (agents/)
 */
export function loadReviewAgents(projectPath: string): AgentDefinition[] {
  const agents: AgentDefinition[] = [];

  const discovered = new Set<string>();

  const overridePath = join(projectPath, '.drs', 'agents');
  const overrideAgents = discoverOverrideAgents(overridePath, overridePath);
  for (const agent of overrideAgents) {
    if (!discovered.has(agent.name)) {
      agents.push(agent);
      discovered.add(agent.name);
    }
  }

  const builtInAgents = discoverAgents(builtInAgentPath, builtInAgentPath);
  for (const agent of builtInAgents) {
    if (!discovered.has(agent.name)) {
      agents.push(agent);
      discovered.add(agent.name);
    }
  }

  return agents;
}

function traverseDirectory(
  basePath: string,
  currentPath: string,
  fileFilter: (entry: string, fullPath: string) => boolean
): string[] {
  const files: string[] = [];

  if (!existsSync(currentPath)) {
    return files;
  }

  const entries = readdirSync(currentPath);

  for (const entry of entries) {
    const fullPath = join(currentPath, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...traverseDirectory(basePath, fullPath, fileFilter));
    } else if (stat.isFile() && fileFilter(entry, fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Recursively discover agent markdown files in a directory
 */
function discoverAgents(basePath: string, currentPath: string): AgentDefinition[] {
  const files = traverseDirectory(basePath, currentPath, (entry) => entry.endsWith('.md'));

  return files
    .map((filePath) => parseAgentFile(filePath, basePath))
    .filter((agent): agent is AgentDefinition => Boolean(agent));
}

/**
 * Parse an agent markdown file and extract frontmatter
 */
function parseAgentFile(
  filePath: string,
  basePath: string,
  nameOverride?: string
): AgentDefinition | null {
  try {
    const content = readFileSync(filePath, 'utf-8');

    // Extract YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

    if (!frontmatterMatch) {
      console.warn(`No frontmatter found in ${filePath}`);
      return null;
    }

    const frontmatter = yaml.parse(frontmatterMatch[1]);

    // Generate agent name from relative path
    const agentName =
      nameOverride ?? relative(basePath, filePath).replace(/\.md$/, '').replace(/\\/g, '/');

    return {
      name: agentName,
      path: filePath,
      description: frontmatter.description || '',
      color: frontmatter.color,
      model: frontmatter.model,
      tools: frontmatter.tools,
      hidden: frontmatter.hidden || false,
    };
  } catch (error) {
    console.error(`Error parsing agent file ${filePath}:`, error);
    return null;
  }
}

/**
 * Discover override agents from .drs/agents/<name>/agent.md
 */
function discoverOverrideAgents(basePath: string, currentPath: string): AgentDefinition[] {
  const files = traverseDirectory(basePath, currentPath, (entry) => entry === 'agent.md');

  return files
    .map((fullPath) => {
      const relativePath = relative(basePath, fullPath).replace(/\\/g, '/');
      const stripped = relativePath.replace(/\/agent\.md$/, '');
      const agentName = stripped.startsWith('review/') ? stripped : `review/${stripped}`;
      return parseAgentFile(fullPath, basePath, agentName);
    })
    .filter((agent): agent is AgentDefinition => Boolean(agent));
}

/**
 * Get a specific agent by name
 */
export function getAgent(projectPath: string, agentName: string): AgentDefinition | null {
  const agents = loadReviewAgents(projectPath);
  return agents.find((a) => a.name === agentName) || null;
}

/**
 * Get all review agents (security, quality, style, performance, documentation)
 */
export function getReviewAgents(projectPath: string): AgentDefinition[] {
  const agents = loadReviewAgents(projectPath);
  return agents.filter((a) => a.name.startsWith('review/'));
}

/**
 * List all available agents
 */
export function listAgents(projectPath: string): string[] {
  const agents = loadReviewAgents(projectPath);
  return agents.map((a) => a.name);
}
