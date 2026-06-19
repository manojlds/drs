import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, relative } from 'path';
import * as yaml from 'yaml';
import { getAgentIdValidationError, parseAgentId } from '../lib/agent-id.js';
import type { DRSConfig } from '../lib/config.js';
import { getBuiltInAgentPaths } from './built-in-paths.js';
import { resolveAgentPaths } from './path-config.js';

export interface AgentDefinition {
  id: string;
  namespace: string;
  name: string;
  path: string;
  description: string;
  prompt?: string;
  color?: string;
  model?: string;
  tools?: Record<string, boolean>;
  /** Skills declared in agent frontmatter and merged with config-level skills at runtime. */
  skills?: string[];
  hidden?: boolean;
}

class InvalidProjectAgentPathError extends Error {}

/** Parse a frontmatter value into a trimmed, non-empty string array. */
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parsed = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : undefined;
}

/**
 * Load agents from a project directory.
 *
 * Priority order:
 * 1. Project .drs/agents/<namespace>/<name>/agent.md (DRS-specific overrides/custom)
 * 2. Built-in agents shipped with DRS (.pi/agents)
 */
export function loadAgents(projectPath: string, config?: DRSConfig): AgentDefinition[] {
  const agents: AgentDefinition[] = [];

  const discovered = new Set<string>();
  const { agentsPath } = resolveAgentPaths(projectPath, config);

  const overrideAgents = discoverProjectAgents(agentsPath, agentsPath);
  for (const agent of overrideAgents) {
    if (!discovered.has(agent.id)) {
      agents.push(agent);
      discovered.add(agent.id);
    }
  }

  for (const builtInPath of getBuiltInAgentPaths()) {
    const builtInAgents = discoverAgents(builtInPath, builtInPath);
    for (const agent of builtInAgents) {
      if (!discovered.has(agent.id)) {
        agents.push(agent);
        discovered.add(agent.id);
      }
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
  nameOverride?: string,
  failOnInvalidAgentId = false
): AgentDefinition | null {
  try {
    const content = readFileSync(filePath, 'utf-8');

    // Extract YAML frontmatter
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);

    if (!frontmatterMatch) {
      console.warn(`No frontmatter found in ${filePath}`);
      return null;
    }

    const frontmatter = yaml.parse(frontmatterMatch[1]) ?? {};

    // Generate agent name from relative path
    const agentId =
      nameOverride ?? relative(basePath, filePath).replace(/\.md$/, '').replace(/\\/g, '/');
    const parsedAgentId = parseAgentId(agentId);
    if (!parsedAgentId) {
      const guidance = !agentId.includes('/')
        ? ` Move it to .drs/agents/review/${agentId}/agent.md for a review agent.`
        : '';
      const error = new InvalidProjectAgentPathError(
        `${getAgentIdValidationError(agentId)} Project agents must be stored as .drs/agents/<namespace>/<name>/agent.md.${guidance} File: ${filePath}`
      );
      throw error;
    }

    const prompt = content.slice(frontmatterMatch[0].length).trim();

    return {
      id: agentId,
      namespace: parsedAgentId.namespace,
      name: parsedAgentId.name,
      path: filePath,
      description: frontmatter.description ?? '',
      prompt,
      color: frontmatter.color,
      model: frontmatter.model,
      tools: frontmatter.tools,
      skills: asStringArray(frontmatter.skills),
      hidden: frontmatter.hidden ?? false,
    };
  } catch (error) {
    if (failOnInvalidAgentId && error instanceof InvalidProjectAgentPathError) {
      throw error;
    }

    console.error(`Error parsing agent file ${filePath}:`, error);
    return null;
  }
}

/**
 * Discover project agents from .drs/agents/<namespace>/<name>/agent.md
 */
function discoverProjectAgents(basePath: string, currentPath: string): AgentDefinition[] {
  const files = traverseDirectory(basePath, currentPath, (entry) => entry === 'agent.md');

  return files
    .map((fullPath) => {
      const relativePath = relative(basePath, fullPath).replace(/\\/g, '/');
      const agentId = relativePath.replace(/\/agent\.md$/, '');
      return parseAgentFile(fullPath, basePath, agentId, true);
    })
    .filter((agent): agent is AgentDefinition => Boolean(agent));
}

/**
 * Get a specific agent by name
 */
export function getAgent(
  projectPath: string,
  agentId: string,
  config?: DRSConfig
): AgentDefinition | null {
  const agents = loadAgents(projectPath, config);
  return agents.find((a) => a.id === agentId) ?? null;
}

/**
 * Get all agents in a namespace.
 */
export function getAgentsByNamespace(
  projectPath: string,
  namespace: string,
  config?: DRSConfig
): AgentDefinition[] {
  const agents = loadAgents(projectPath, config);
  return agents.filter((a) => a.namespace === namespace);
}

/**
 * List all available agents
 */
export function listAgents(projectPath: string, config?: DRSConfig): string[] {
  const agents = loadAgents(projectPath, config);
  return agents.map((a) => a.id);
}
