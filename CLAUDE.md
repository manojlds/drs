# DRS - Diff Review System

## Project Overview
DRS is an AI-powered code review system that integrates with GitLab merge requests and local git workflows using Claude Code SDK. It provides context-aware code analysis with intelligent git command generation and supports multiple output formats for seamless CI/CD integration.

## Key Features
- **Triple Context Support**:
  - Local development (staged, unstaged, untracked files)
  - GitLab MR review via local `glab` CLI
  - GitLab CI/CD with proper MR branch diffing
- **Multiple Output Formats**:
  - Human-readable text format for local development
  - GitLab Code Quality JSON format for CI/CD integration
- **Context-Aware Git Commands**: Generates appropriate git commands based on review context
- **Intelligent Context Detection**: Auto-detects CI/CD vs local vs MR environments
- **Claude Code Subagent Integration**: Uses specialized code-reviewer subagent for consistent reviews
- **Modular Architecture**: Clean separation of concerns across focused modules

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

# Full codebase review (when no changes detected)
uv run drs --full-review --format text
uv run drs --full-review --format gitlab-json -o full-review.json
```

### CLI Arguments
- `--mr-id <ID>`: GitLab Merge Request ID to review
- `--local`: Force local git diff mode (includes staged, unstaged, and untracked files)
- `--format <FORMAT>`: Output format - `text`, `gitlab-json`, or `auto` (default)
- `-o, --output <FILE>`: Write output to file instead of stdout
- `--full-review`: Perform comprehensive codebase review even when no changes detected

### Output Format Options
- `text` (default for local): Human-readable markdown format
- `gitlab-json`: GitLab Code Quality JSON format for CI/CD
- `auto`: Automatically chooses JSON for CI/CD, text for local

### GitLab CI/CD Integration
When running in GitLab CI/CD with merge request context, DRS automatically:
- Detects CI environment via `CI` and `CI_PIPELINE_SOURCE` variables
- Uses `CI_MERGE_REQUEST_ID` for MR context
- Outputs GitLab JSON format when `--format auto` (default)

## Architecture

### Modular Design
DRS uses a clean modular architecture with separation of concerns:

- **`drs/main.py`** (~45 lines): CLI entry point and argument parsing
- **`drs/context.py`** (~130 lines): Context detection and git command generation
- **`drs/claude_integration.py`** (~110 lines): Claude Code SDK integration and formatting
- **`drs/reviewer.py`** (~65 lines): Main review orchestration and workflow
- **`.claude/agents/code-reviewer.md`**: Specialized code review subagent
- **`.claude/settings.local.json`**: Local Claude Code permissions

### Context-Aware Git Commands
DRS intelligently generates different git commands based on review context:

**Local Development**:
```bash
git status
git diff --cached    # staged changes
git diff            # unstaged changes
git ls-files --others --exclude-standard  # untracked files
```

**GitLab CI/CD (Proper MR Scope)**:
```bash
git status
git diff origin/main...HEAD    # ALL commits in MR vs target branch
```

**Local MR Review**:
```bash
git status
glab mr diff 123    # Full MR diff via GitLab API
```

## Dependencies
- **`claude-code-sdk`**: For AI-powered code analysis
- **`ruff`**: Code linting and formatting (dev)
- **`mypy`**: Type checking (dev)
- **Python 3.12+** required
- **`glab` CLI tool** for GitLab integration (when using MR mode)

## Development Commands
```bash
# Install in development mode
uv sync

# Set up pre-commit hooks (recommended)
uv run pre-commit install

# Run pre-commit on all files
uv run pre-commit run --all-files

# Test CLI functionality
uv run drs --help
uv run drs --local --format text

# Test with specific MR (requires glab CLI)
uv run drs --mr-id 123 --format gitlab-json

# Manual linting and formatting
uv run ruff check --fix
uv run ruff format
```

## Code Review Process
1. **Context Detection**: Determines review environment (local/MR-local/MR-CI)
2. **Git Command Generation**: Creates context-specific git commands for subagent
3. **Format-Aware Prompting**: Instructs subagent to output in requested format
4. **Subagent Analysis**: Invokes @code-reviewer subagent with generated commands
5. **Output Processing**: Validates JSON format or passes through text format
6. **File Output**: Supports writing to files for CI/CD integration

## Key Improvements Over Traditional Tools
- **No Redundant Git Operations**: Single source of truth for git commands
- **Proper MR Scope**: Reviews all commits in MR, not just latest
- **Context Awareness**: Different strategies for different environments
- **Direct JSON Generation**: AI outputs GitLab format directly, no fragile parsing
- **Modular & Testable**: Clean architecture for easy maintenance

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
