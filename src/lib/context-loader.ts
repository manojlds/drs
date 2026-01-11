import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface AgentContext {
  /**
   * Source of the agent definition
   * - 'override': Using .drs/agents/{name}/agent.md (full replacement)
   * - 'default': Using built-in agent
   */
  source: 'override' | 'default';

  /**
   * Agent-specific context from .drs/agents/{name}/context.md
   */
  agentContext?: string;

  /**
   * Full agent definition (only for overrides)
   */
  agentDefinition?: string;
}

const fallbackJsonContract = `**Required JSON output format:**\n\n\`\`\`json\n{\n  \"issues\": [\n    {\n      \"category\": \"SECURITY\" | \"QUALITY\" | \"STYLE\" | \"PERFORMANCE\",\n      \"severity\": \"CRITICAL\" | \"HIGH\" | \"MEDIUM\" | \"LOW\",\n      \"title\": \"Brief title\",\n      \"file\": \"path/to/file.ts\",\n      \"line\": 42,\n      \"problem\": \"Description of the problem\",\n      \"solution\": \"How to fix it\",\n      \"agent\": \"security\" | \"quality\" | \"style\" | \"performance\"\n    }\n  ]\n}\n\`\`\``;

function extractJsonSchemaBlock(basePrompt: string): string | null {
  const match = basePrompt.match(/```json[\s\S]*?```/);
  if (!match) {
    return null;
  }

  return `**Required JSON output format:**\n\n${match[0]}`;
}

/**
 * Load global project context from .drs/context.md
 */
export function loadGlobalContext(projectRoot: string = process.cwd()): string | null {
  const contextPath = join(projectRoot, '.drs', 'context.md');

  if (existsSync(contextPath)) {
    return readFileSync(contextPath, 'utf-8');
  }

  return null;
}

/**
 * Load agent-specific context and check for overrides
 */
export function loadAgentContext(
  agentName: string,
  projectRoot: string = process.cwd()
): AgentContext {
  const agentDir = join(projectRoot, '.drs', 'agents', agentName);

  // Check for full agent override
  const agentDefPath = join(agentDir, 'agent.md');
  if (existsSync(agentDefPath)) {
    return {
      source: 'override',
      agentDefinition: readFileSync(agentDefPath, 'utf-8'),
    };
  }

  // Check for agent-specific context (additive to default agent)
  const contextPath = join(agentDir, 'context.md');
  if (existsSync(contextPath)) {
    return {
      source: 'default',
      agentContext: readFileSync(contextPath, 'utf-8'),
    };
  }

  // No customization, use default
  return {
    source: 'default',
  };
}

/**
 * Build review prompt with global and agent-specific context
 */
export function buildReviewPrompt(
  agentName: string,
  basePrompt: string,
  prNumber: number,
  changedFiles: string[],
  projectRoot: string = process.cwd()
): string {
  const globalContext = loadGlobalContext(projectRoot);
  const agentContext = loadAgentContext(agentName, projectRoot);

  let prompt = '';

  // If agent is fully overridden, use that instead of base prompt
  if (agentContext.source === 'override' && agentContext.agentDefinition) {
    const jsonContract = extractJsonSchemaBlock(basePrompt) ?? fallbackJsonContract;
    prompt = `${agentContext.agentDefinition}\n\n${jsonContract}`;

    // Add task details
    prompt += `\n\nReview the following files from PR #${prNumber}:\n\n`;
    prompt += changedFiles.map((f) => `- ${f}`).join('\n');

    return prompt;
  }

  // Otherwise, build prompt with contexts + base prompt

  // 1. Global project context (if available)
  if (globalContext) {
    prompt += `# Project Context\n\n${globalContext}\n\n`;
  }

  // 2. Agent-specific context (if available)
  if (agentContext.agentContext) {
    prompt += `# ${agentName.charAt(0).toUpperCase() + agentName.slice(1)} Agent Context\n\n`;
    prompt += `${agentContext.agentContext}\n\n`;
  }

  // 3. Base agent instructions
  prompt += basePrompt;

  return prompt;
}
