import { describe, it, expect } from 'vitest';
import { parseReviewIssues } from './issue-parser.js';

describe('parseReviewIssues', () => {
  it('should parse valid JSON code block with issues', () => {
    const content = `Here are my findings:

\`\`\`json
{
  "issues": [
    {
      "category": "SECURITY",
      "severity": "CRITICAL",
      "title": "SQL Injection vulnerability",
      "file": "src/api/users.ts",
      "line": 42,
      "problem": "Query uses string concatenation",
      "solution": "Use parameterized queries",
      "references": ["https://owasp.org/sql-injection"],
      "agent": "security"
    }
  ]
}
\`\`\``;

    const issues = parseReviewIssues(content, 'security');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      category: 'SECURITY',
      severity: 'CRITICAL',
      title: 'SQL Injection vulnerability',
      file: 'src/api/users.ts',
      line: 42,
      problem: 'Query uses string concatenation',
      solution: 'Use parameterized queries',
      references: ['https://owasp.org/sql-injection'],
      agent: 'security',
    });
  });

  it('should parse multiple issues in a single JSON block', () => {
    const content = `\`\`\`json
{
  "issues": [
    {
      "category": "QUALITY",
      "severity": "HIGH",
      "title": "High complexity function",
      "file": "src/utils/helper.ts",
      "line": 10,
      "problem": "Function has cyclomatic complexity of 15",
      "solution": "Break into smaller functions",
      "agent": "quality"
    },
    {
      "category": "QUALITY",
      "severity": "MEDIUM",
      "title": "Code duplication",
      "file": "src/utils/helper.ts",
      "line": 50,
      "problem": "Duplicated validation logic",
      "solution": "Extract to shared validator function"
    }
  ]
}
\`\`\``;

    const issues = parseReviewIssues(content, 'quality');

    expect(issues).toHaveLength(2);
    expect(issues[0].severity).toBe('HIGH');
    expect(issues[1].severity).toBe('MEDIUM');
    expect(issues[1].agent).toBe('quality'); // Should use default agent name
  });

  it('should parse raw JSON without code block markers', () => {
    const content = `{"issues":[{"category":"PERFORMANCE","severity":"LOW","title":"Inefficient loop","file":"src/app.ts","line":5,"problem":"Using nested loops","solution":"Use hash map"}]}`;

    const issues = parseReviewIssues(content, 'performance');

    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe('PERFORMANCE');
    expect(issues[0].file).toBe('src/app.ts');
  });

  it('should handle issues without line numbers', () => {
    const content = `\`\`\`json
{
  "issues": [
    {
      "category": "STYLE",
      "severity": "LOW",
      "title": "Missing file header",
      "file": "src/main.ts",
      "problem": "No copyright header",
      "solution": "Add standard file header",
      "agent": "style"
    }
  ]
}
\`\`\``;

    const issues = parseReviewIssues(content, 'style');

    expect(issues).toHaveLength(1);
    expect(issues[0].line).toBeUndefined();
  });

  it('should handle issues without references', () => {
    const content = `\`\`\`json
{
  "issues": [
    {
      "category": "QUALITY",
      "severity": "MEDIUM",
      "title": "Long function",
      "file": "src/utils.ts",
      "line": 100,
      "problem": "Function exceeds 50 lines",
      "solution": "Refactor into smaller functions",
      "agent": "quality"
    }
  ]
}
\`\`\``;

    const issues = parseReviewIssues(content, 'quality');

    expect(issues).toHaveLength(1);
    expect(issues[0].references).toBeUndefined();
  });

  it('should return empty array for invalid JSON', () => {
    const content = 'This is not valid JSON';

    const issues = parseReviewIssues(content);

    expect(issues).toEqual([]);
  });

  it('should return empty array for JSON without issues array', () => {
    const content = `\`\`\`json
{
  "message": "No issues found"
}
\`\`\``;

    const issues = parseReviewIssues(content);

    expect(issues).toEqual([]);
  });

  it('should skip invalid issues that are missing required fields', () => {
    const content = `\`\`\`json
{
  "issues": [
    {
      "category": "SECURITY",
      "severity": "HIGH",
      "title": "Missing problem field",
      "file": "src/test.ts",
      "solution": "Fix it"
    },
    {
      "category": "QUALITY",
      "severity": "MEDIUM",
      "title": "Valid issue",
      "file": "src/valid.ts",
      "line": 10,
      "problem": "This is valid",
      "solution": "This has all required fields"
    }
  ]
}
\`\`\``;

    const issues = parseReviewIssues(content);

    // Should only parse the valid issue
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe('Valid issue');
  });

  it('should reject issues with invalid category', () => {
    const content = `\`\`\`json
{
  "issues": [
    {
      "category": "INVALID_CATEGORY",
      "severity": "HIGH",
      "title": "Test",
      "file": "test.ts",
      "problem": "Problem",
      "solution": "Solution"
    }
  ]
}
\`\`\``;

    const issues = parseReviewIssues(content);

    expect(issues).toEqual([]);
  });

  it('should reject issues with invalid severity', () => {
    const content = `\`\`\`json
{
  "issues": [
    {
      "category": "SECURITY",
      "severity": "SUPER_CRITICAL",
      "title": "Test",
      "file": "test.ts",
      "problem": "Problem",
      "solution": "Solution"
    }
  ]
}
\`\`\``;

    const issues = parseReviewIssues(content);

    expect(issues).toEqual([]);
  });

  it('should handle multiple JSON blocks in same content', () => {
    const content = `First agent findings:

\`\`\`json
{
  "issues": [
    {
      "category": "SECURITY",
      "severity": "HIGH",
      "title": "Issue 1",
      "file": "src/a.ts",
      "line": 1,
      "problem": "Problem 1",
      "solution": "Solution 1",
      "agent": "security"
    }
  ]
}
\`\`\`

Second agent findings:

\`\`\`json
{
  "issues": [
    {
      "category": "QUALITY",
      "severity": "MEDIUM",
      "title": "Issue 2",
      "file": "src/b.ts",
      "line": 2,
      "problem": "Problem 2",
      "solution": "Solution 2",
      "agent": "quality"
    }
  ]
}
\`\`\``;

    const issues = parseReviewIssues(content);

    expect(issues).toHaveLength(2);
    expect(issues[0].agent).toBe('security');
    expect(issues[1].agent).toBe('quality');
  });

  it('should use provided agent name when issue does not have agent field', () => {
    const content = `\`\`\`json
{
  "issues": [
    {
      "category": "PERFORMANCE",
      "severity": "LOW",
      "title": "Slow operation",
      "file": "src/perf.ts",
      "line": 20,
      "problem": "Inefficient algorithm",
      "solution": "Use better algorithm"
    }
  ]
}
\`\`\``;

    const issues = parseReviewIssues(content, 'performance-agent');

    expect(issues).toHaveLength(1);
    expect(issues[0].agent).toBe('performance-agent');
  });

  it('should handle whitespace in JSON code blocks', () => {
    const content = `\`\`\`json

{
  "issues": [
    {
      "category": "STYLE",
      "severity": "LOW",
      "title": "Formatting",
      "file": "src/style.ts",
      "line": 1,
      "problem": "Inconsistent formatting",
      "solution": "Run prettier"
    }
  ]
}

\`\`\``;

    const issues = parseReviewIssues(content);

    expect(issues).toHaveLength(1);
  });
});
