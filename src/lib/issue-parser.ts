import type { ReviewIssue } from './comment-formatter.js';

/**
 * Parse review issues from agent response messages
 *
 * Agents should output JSON in the following format:
 * ```json
 * {
 *   "issues": [
 *     {
 *       "category": "SECURITY" | "QUALITY" | "STYLE" | "PERFORMANCE",
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
  const issues: ReviewIssue[] = [];

  try {
    // Try to find JSON blocks in the content
    // Look for code blocks with ```json or raw JSON objects
    const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/g;

    let match;

    // First try to find JSON code blocks
    while ((match = jsonBlockRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.issues && Array.isArray(parsed.issues)) {
          for (const issue of parsed.issues) {
            if (isValidIssue(issue)) {
              issues.push({
                ...issue,
                agent: issue.agent || agentName,
              });
            }
          }
        }
      } catch (e) {
        // Continue to next match
      }
    }

    // If no code blocks found, try to find raw JSON objects
    if (issues.length === 0) {
      // Try to parse the entire content as JSON
      try {
        const parsed = JSON.parse(content);
        if (parsed.issues && Array.isArray(parsed.issues)) {
          for (const issue of parsed.issues) {
            if (isValidIssue(issue)) {
              issues.push({
                ...issue,
                agent: issue.agent || agentName,
              });
            }
          }
        }
      } catch (e) {
        // Not valid JSON, try to find JSON objects with better bracket matching
        const jsonObjects = extractJsonObjects(content);
        for (const jsonStr of jsonObjects) {
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.issues && Array.isArray(parsed.issues)) {
              for (const issue of parsed.issues) {
                if (isValidIssue(issue)) {
                  issues.push({
                    ...issue,
                    agent: issue.agent || agentName,
                  });
                }
              }
            }
          } catch (e) {
            // Continue to next object
          }
        }
      }
    }
  } catch (error) {
    console.warn('Failed to parse review issues from content:', error);
  }

  return issues;
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
function isValidIssue(obj: any): obj is ReviewIssue {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.category === 'string' &&
    ['SECURITY', 'QUALITY', 'STYLE', 'PERFORMANCE'].includes(obj.category) &&
    typeof obj.severity === 'string' &&
    ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(obj.severity) &&
    typeof obj.title === 'string' &&
    typeof obj.file === 'string' &&
    typeof obj.problem === 'string' &&
    typeof obj.solution === 'string' &&
    (obj.line === undefined || typeof obj.line === 'number') &&
    (obj.references === undefined || Array.isArray(obj.references)) &&
    (obj.agent === undefined || typeof obj.agent === 'string')
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
