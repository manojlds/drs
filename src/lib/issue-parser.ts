import type { ReviewIssue } from './comment-formatter.js';

/**
 * Parse review issues from agent response messages
 *
 * Agents should output JSON in the following format:
 * ```json
 * {
 *   "issues": [
 *     {
 *       "category": "SECURITY" | "QUALITY" | "STYLE" | "PERFORMANCE" | "DOCUMENTATION",
 *       "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
 *       "title": "Issue title",
 *       "file": "path/to/file.ts",
 *       "line": 42,
 *       "problem": "Description of the problem",
 *       "solution": "Suggested fix",
 *       "references": ["https://link1", "https://link2"],
 *       "agent": "security"
 *     }
 *   ]
 * }
 * ```
 */
export function parseReviewIssues(content: string, agentName: string = 'unknown'): ReviewIssue[] {
  return parseReviewIssuesWithDiagnostics(content, agentName).issues;
}

export interface ReviewIssueParserDiagnostics {
  rawResponsePresent: boolean;
  validJson: boolean;
  validReviewSchema: boolean;
  emittedCount: number;
  validCount: number;
  invalidCount: number;
  errors: string[];
}

export interface ReviewIssueParseResult {
  issues: ReviewIssue[];
  diagnostics: ReviewIssueParserDiagnostics;
}

/** Parse issues while exposing failures which the legacy API intentionally hides. */
export function parseReviewIssuesWithDiagnostics(
  content: string,
  agentName: string = 'unknown'
): ReviewIssueParseResult {
  const issues: ReviewIssue[] = [];
  const diagnostics: ReviewIssueParserDiagnostics = {
    rawResponsePresent: content.trim().length > 0,
    validJson: false,
    validReviewSchema: false,
    emittedCount: 0,
    validCount: 0,
    invalidCount: 0,
    errors: [],
  };
  const consumedPayloads = new Set<string>();

  const consume = (parsed: unknown, payload: string): void => {
    const normalizedPayload = payload.trim();
    if (consumedPayloads.has(normalizedPayload)) return;
    consumedPayloads.add(normalizedPayload);
    diagnostics.validJson = true;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { issues?: unknown }).issues)
    ) {
      diagnostics.errors.push('JSON does not contain an issues array.');
      return;
    }
    diagnostics.validReviewSchema = true;
    const emitted = (parsed as { issues: unknown[] }).issues;
    diagnostics.emittedCount += emitted.length;
    for (const issue of emitted) {
      if (isValidIssue(issue)) issues.push({ ...issue, agent: issue.agent || agentName });
      else diagnostics.invalidCount++;
    }
  };

  try {
    // Try to find JSON blocks in the content
    // Look for code blocks with ```json or raw JSON objects
    const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/g;

    let match;

    // First try to find JSON code blocks
    while ((match = jsonBlockRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        consume(parsed, match[1]);
      } catch {
        diagnostics.errors.push('Invalid JSON code block.');
      }
    }

    // If no code blocks found, try to find raw JSON objects
    if (issues.length === 0) {
      // Try to parse the entire content as JSON
      try {
        const parsed = JSON.parse(content);
        consume(parsed, content);
      } catch {
        // Not valid JSON, try to find JSON objects with better bracket matching
        const jsonObjects = extractJsonObjects(content);
        for (const jsonStr of jsonObjects) {
          try {
            const parsed = JSON.parse(jsonStr);
            consume(parsed, jsonStr);
          } catch {
            // Continue to next object
          }
        }
      }
    }
  } catch (error) {
    diagnostics.errors.push(error instanceof Error ? error.message : String(error));
  }

  if (!diagnostics.rawResponsePresent) diagnostics.errors.push('Empty response.');
  else if (!diagnostics.validJson) diagnostics.errors.push('No valid JSON review response found.');
  diagnostics.validCount = issues.length;
  return { issues, diagnostics };
}

/**
 * Extract JSON objects from text by matching brackets
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const obj = text.substring(start, i + 1);
        // Only consider objects that contain "issues"
        if (obj.includes('"issues"')) {
          objects.push(obj);
        }
        start = -1;
      }
    }
  }

  return objects;
}

/**
 * Validate that an object has the required ReviewIssue fields
 */
function isValidIssue(obj: unknown): obj is ReviewIssue {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const record = obj as Record<string, unknown>;

  return (
    typeof record.category === 'string' &&
    ['SECURITY', 'QUALITY', 'STYLE', 'PERFORMANCE', 'DOCUMENTATION'].includes(record.category) &&
    typeof record.severity === 'string' &&
    ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(record.severity) &&
    typeof record.title === 'string' &&
    typeof record.file === 'string' &&
    typeof record.problem === 'string' &&
    typeof record.solution === 'string' &&
    (record.line === undefined || typeof record.line === 'number') &&
    (record.references === undefined || Array.isArray(record.references)) &&
    (record.agent === undefined || typeof record.agent === 'string')
  );
}

/**
 * Extract agent name from session context or message
 */
export function extractAgentName(message: string): string {
  // Try to extract from common patterns like "Agent: security" or "Reviewer: quality"
  const agentMatch = message.match(/(?:agent|reviewer):\s*(\w+)/i);
  if (agentMatch) {
    return agentMatch[1];
  }
  return 'unknown';
}
