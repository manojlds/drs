import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, relative } from 'path';
import * as yaml from 'yaml';

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
 * 1. Project .drs/agents/ (DRS-specific)
 * 2. Project .opencode/agent/ (OpenCode standard)
 * 3. Global DRS agents (fallback)
 */
export function loadReviewAgents(projectPath: string): AgentDefinition[] {
  const agents: AgentDefinition[] = [];

  // Define search paths in priority order
  const agentPaths = [join(projectPath, '.drs/agents'), join(projectPath, '.opencode/agent')];

  const discovered = new Set<string>();

  for (const agentPath of agentPaths) {
    if (!existsSync(agentPath)) {
      continue;
    }

    const foundAgents = discoverAgents(agentPath, agentPath);

    for (const agent of foundAgents) {
      // Only add if we haven't seen this agent name before (priority order)
      if (!discovered.has(agent.name)) {
        agents.push(agent);
        discovered.add(agent.name);
      }
    }
  }

  return agents;
}

/**
 * Recursively discover agent markdown files in a directory
 */
function discoverAgents(basePath: string, currentPath: string): AgentDefinition[] {
  const agents: AgentDefinition[] = [];

  if (!existsSync(currentPath)) {
    return agents;
  }

  const entries = readdirSync(currentPath);

  for (const entry of entries) {
    const fullPath = join(currentPath, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Recursively search subdirectories
      agents.push(...discoverAgents(basePath, fullPath));
    } else if (stat.isFile() && entry.endsWith('.md')) {
      // Parse markdown file as agent definition
      const agent = parseAgentFile(fullPath, basePath);
      if (agent) {
        agents.push(agent);
      }
    }
  }

  return agents;
}

/**
 * Parse an agent markdown file and extract frontmatter
 */
function parseAgentFile(filePath: string, basePath: string): AgentDefinition | null {
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
    const relativePath = relative(basePath, filePath);
    const agentName = relativePath.replace(/\.md$/, '').replace(/\\/g, '/');

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
 * Get a specific agent by name
 */
export function getAgent(projectPath: string, agentName: string): AgentDefinition | null {
  const agents = loadReviewAgents(projectPath);
  return agents.find((a) => a.name === agentName) || null;
}

/**
 * Get all review agents (security, quality, style, performance)
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
