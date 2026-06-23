import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { DRSConfig } from './config.js';
import { requireAgentId } from './agent-id.js';
import { resolveAgentPaths } from '../runtime/path-config.js';
import type { ReviewVerificationContext } from './review-orchestrator.js';

function severityRankValue(severity: string): number {
  const normalized = severity.trim().toUpperCase();
  if (normalized === 'CRITICAL') return 4;
  if (normalized === 'HIGH') return 3;
  if (normalized === 'MEDIUM') return 2;
  if (normalized === 'LOW') return 1;
  return 0;
}

export interface AgentContext {
  /**
   * Source of the agent definition
   * - 'override': Using .drs/agents/{namespace}/{name}/agent.md (full replacement)
   * - 'default': Using built-in agent
   */
  source: 'override' | 'default';

  /**
   * Agent-specific context from .drs/agents/{namespace}/{name}/context.md
   */
  agentContext?: string;

  /**
   * Full agent definition (only for overrides)
   */
  agentDefinition?: string;
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
  agentId: string,
  projectRoot: string = process.cwd(),
  config?: DRSConfig
): AgentContext {
  const { namespace, name } = requireAgentId(agentId);
  const { agentsPath } = resolveAgentPaths(projectRoot, config);
  const agentDir = join(agentsPath, namespace, name);

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
  agentId: string,
  basePrompt: string,
  reviewLabel: string,
  changedFiles: string[],
  projectRoot: string = process.cwd(),
  config?: DRSConfig,
  describeSummary?: string,
  verificationContext?: ReviewVerificationContext
): string {
  const globalContext = loadGlobalContext(projectRoot);
  const agentContext = loadAgentContext(agentId, projectRoot, config);

  let prompt = '';

  // If agent is fully overridden, use that instead of base prompt
  if (agentContext.source === 'override' && agentContext.agentDefinition) {
    prompt = agentContext.agentDefinition;

    // Add task details
    prompt += `\n\nReview the following files from ${reviewLabel}:\n\n`;
    prompt += changedFiles.map((f) => `- ${f}`).join('\n');

    return prompt;
  }

  // Otherwise, build prompt with contexts + base prompt

  // 1. Global project context (if available)
  if (globalContext) {
    const trimmedContext = globalContext.trim();
    const firstLine = trimmedContext.split('\n').find((line) => line.trim().length > 0) ?? '';
    if (/^#\s*project context/i.test(firstLine)) {
      prompt += `${trimmedContext}\n\n`;
    } else {
      prompt += `# Project Context\n\n${trimmedContext}\n\n`;
    }
  }

  // 1.5 Describe summary (change context from describe agent)
  if (describeSummary) {
    prompt += `# Change Summary\n\n${describeSummary}\n\n`;
  }

  if (verificationContext) {
    prompt += formatVerificationContext(verificationContext);
  }

  // 2. Agent-specific context (if available)
  if (agentContext.agentContext) {
    const agentLabel = agentId.split('/').pop() ?? agentId;
    prompt += `# ${agentLabel.charAt(0).toUpperCase() + agentLabel.slice(1)} Agent Context\n\n`;
    prompt += `${agentContext.agentContext}\n\n`;
  }

  // 3. Base agent instructions
  prompt += basePrompt;

  return prompt;
}

function formatVerificationContext(context: ReviewVerificationContext): string {
  const severityText = context.severity ? ` at or above ${context.severity}` : '';
  const thresholdRank = context.severity ? severityRankValue(context.severity) : 0;
  const findingsToVerify = context.artifact.findings.filter(
    (f) => !thresholdRank || severityRankValue(f.issue.severity) >= thresholdRank
  );
  const findingIds = findingsToVerify.map((f) => f.id).join(', ');
  const manifest = findingsToVerify
    .map(
      (f) =>
        `- ${f.id} | ${f.issue.severity} | ${f.issue.file}${f.issue.line ? `:${f.issue.line}` : ''} | ${f.disposition} | ${f.issue.title}`
    )
    .join('\n');

  let prompt = `# Fix Verification Context

This is a verification review over the full post-fix diff. Verify the existing review findings${severityText} before reporting anything else.

You MUST output a verification finding for EACH of these IDs: ${findingIds}

Missing verdicts will be treated as still_open. Do not skip any finding.

For each finding, decide whether it is:
- resolved: the original issue no longer exists in the current code
- still_open: the same issue still exists
- partial: the fix attempted the issue but is incomplete or moved the problem

Do not mark a finding resolved just because it is absent from a narrower local fix diff. Use the full diff and surrounding code as needed.

## Findings to verify

${manifest}

`;

  if (context.artifactPath) {
    prompt += `Use the read_artifact tool with artifact path "${context.artifactPath}" and a specific findingId to pull full issue details (problem, solution, verification rationale) for any finding you need to examine more closely.

`;
  }

  prompt += `In your review output JSON, include this additional top-level field:
{
  "verification": {
    "findings": [
      {
        "id": "${findingsToVerify[0]?.id ?? 'F001'}",
        "disposition": "resolved",
        "rationale": "short explanation",
        "issue": null
      }
    ]
  }
}

The allowed disposition values are: resolved, still_open, partial.

The normal top-level "issues" array should contain only new regressions introduced by the fix, not the original findings being verified.

`;

  return prompt;
}
