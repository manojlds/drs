# Security Agent Context for DRS

## Project-Specific Security Rules

### What NOT to Flag as Security Issues

#### Environment Variables
- ✅ `process.env.GITHUB_TOKEN` - Standard practice for CLI tools
- ✅ `process.env.OPENCODE_SERVER` - Configuration via env vars is correct
- ✅ `process.env.*` in general - This is a CLI tool, not a web app

#### Trusted API Data
- ✅ File paths from `github.getPRFiles()` - Validated by GitHub's API
- ✅ PR data from `github.getPullRequest()` - Trusted source
- ✅ Commit SHAs from GitHub - Not user-controlled
- ✅ Repository owner/name from CLI flags - Validated by Commander.js

#### Safe Patterns
- ✅ Markdown content posted to GitHub - Safely rendered by GitHub
- ✅ HTML comments like `<!-- drs-comment-id: ... -->` - Industry standard for bot identification
- ✅ Simple regex patterns like `/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/` - No ReDoS risk
- ✅ JSON parsing of known structures - Expected behavior

#### API Client Patterns
- ✅ Returning `any` from API wrappers initially is acceptable (we're improving this)
- ✅ Not validating tokens before use - API calls will fail naturally with invalid tokens
- ✅ Using GitHub API without additional validation - GitHub validates everything

### What TO Flag

#### Real Security Vulnerabilities
- ❌ Shell command injection (e.g., `exec(userInput)`)
- ❌ Path traversal with user-controlled paths (not GitHub API paths)
- ❌ SQL injection (if we add database)
- ❌ Arbitrary code execution via `eval()` or similar
- ❌ Prototype pollution vulnerabilities
- ❌ Token leakage in logs or error messages

#### Bad Practices
- ⚠️ Logging sensitive data (tokens, credentials)
- ⚠️ Inadequate error handling that leaks stack traces with credentials
- ⚠️ Using deprecated or vulnerable dependencies

### NOT Applicable to This Project
- XSS (we don't render HTML in a browser)
- CSRF (no web forms)
- Session fixation (no sessions)
- Authentication bypass (no auth system)
- SQL injection (no database)

## Severity Calibration

### CRITICAL
- Actively exploitable vulnerabilities with high impact
- Token leakage to external systems
- Remote code execution possibilities
- Example: `exec(userInput)` without sanitization

### HIGH
- Real security issues requiring attention but not immediately exploitable
- Inadequate error handling that could leak credentials
- Use of known vulnerable dependencies
- Example: Logging tokens in error messages

### MEDIUM
- Security hardening opportunities
- Potential edge cases
- Missing input validation on non-critical paths
- Example: Not checking file path lengths

### LOW
- Best practice improvements
- Defense-in-depth suggestions
- Documentation of security considerations
- Example: Adding JSDoc security notes

## Context Awareness

Remember:
- This is a **CLI tool** for developers, not a web application
- The attack surface is minimal - users run it in their own environment
- Inputs are primarily from trusted APIs (GitHub)
- Focus on **real issues** that could cause harm in the actual use case
