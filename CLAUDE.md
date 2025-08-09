# DRS - Diff Review System

## Project Overview
DRS is an AI-powered code review system that integrates with GitLab merge requests and local git workflows using Claude Code SDK.

## Key Features
- **Dual Context Support**: Works in both GitLab CI/CD and local development environments
- **Multiple Output Formats**: 
  - Human-readable text format for local development
  - GitLab Code Quality JSON format for CI/CD integration
- **Intelligent Context Detection**: Automatically detects CI/CD vs local environment
- **Claude Code Subagent Integration**: Uses specialized code-reviewer subagent for consistent reviews

## Setup & Installation

This is a uv-managed Python project. Use the following commands:

```bash
# Sync dependencies
uv sync

# Run DRS CLI
uv run drs --help
```

## CLI Usage

### Basic Usage
```bash
# Review a GitLab merge request (local mode)
uv run drs --mr-id 123

# Force local git diff mode (includes untracked files)
uv run drs --local

# Specify output format
uv run drs --mr-id 123 --format gitlab-json
uv run drs --local --format text

# Output to file
uv run drs --local --format gitlab-json --output code-quality-report.json
uv run drs --local --format text -o review.md
```

### CLI Arguments
- `--mr-id <ID>`: GitLab Merge Request ID to review
- `--local`: Force local git diff mode (includes staged, unstaged, and untracked files)
- `--format <FORMAT>`: Output format - `text`, `gitlab-json`, or `auto` (default)
- `-o, --output <FILE>`: Write output to file instead of stdout

### Output Format Options
- `text` (default for local): Human-readable markdown format
- `gitlab-json`: GitLab Code Quality JSON format for CI/CD
- `auto`: Automatically chooses JSON for CI/CD, text for local

### GitLab CI/CD Integration
When running in GitLab CI/CD with merge request context, DRS automatically:
- Detects CI environment via `CI` and `CI_PIPELINE_SOURCE` variables
- Uses `CI_MERGE_REQUEST_ID` for MR context
- Outputs GitLab JSON format when `--format auto` (default)

## Project Structure
- `drs/main.py`: Main CLI application with context detection and output formatting
- `.claude/agents/code-reviewer.md`: Claude Code subagent for comprehensive code review
- `.claude/settings.local.json`: Local Claude Code permissions

## Dependencies
- `claude-code-sdk`: For AI-powered code analysis
- Python 3.12+ required
- `glab` CLI tool for GitLab integration (when using MR mode)

## Development Commands
```bash
# Install in development mode
uv sync

# Test CLI functionality
uv run drs --help
uv run drs --local --format text

# Test with specific MR (requires glab CLI)
uv run drs --mr-id 123 --format gitlab-json
```

## Code Review Process
1. **Context Detection**: Determines if running in CI/CD or locally
2. **Diff Retrieval**: Gets changes from GitLab MR or local git diff
3. **Subagent Analysis**: Invokes @code-reviewer subagent via Claude Code SDK
4. **Output Formatting**: Converts to requested format (text/JSON)

## CI/CD Integration Example
```yaml
# .gitlab-ci.yml
code_quality:
  script:
    - uv run drs --format gitlab-json > gl-code-quality-report.json
  artifacts:
    reports:
      codequality: gl-code-quality-report.json
```