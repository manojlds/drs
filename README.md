# DRS - Diff Review System 🧠🔍

> AI-powered code review with intelligent context detection and GitLab integration ✨

[![Python 3.12+](https://img.shields.io/badge/python-3.12+-blue.svg)](https://www.python.org/downloads/)
[![uv](https://img.shields.io/badge/built%20with-uv-green)](https://github.com/astral-sh/uv)
[![Code style: ruff](https://img.shields.io/badge/code%20style-ruff-000000.svg)](https://github.com/astral-sh/ruff)

## What is DRS?

DRS is a modern code review system that leverages the Claude Code SDK to provide intelligent, context-aware code analysis. Unlike traditional static analysis tools, DRS understands your development workflow and adapts its review strategy based on whether you're working locally, reviewing merge requests, or running in CI/CD environments.

## Key Features

### Smart Context Detection 🔎
- **Local Development**: Reviews `staged`, `unstaged`, and `untracked` files
- **MR Review (Local)**: Uses GitLab CLI for comprehensive MR analysis
- **GitLab CI/CD**: Proper branch diffing with full MR scope

### Multiple Output Formats 🧾
- **Human-readable text** for local development and debugging
- **GitLab Code Quality JSON** for seamless CI/CD integration
- **Auto-detection** based on environment

### AI-Powered Analysis 🤖
- Uses Claude Code SDK for deep semantic understanding
- Specialized code-reviewer subagent for consistent quality
- Context-aware git command generation

### Clean Architecture 🧱
- Modular design with separation of concerns
- Easy to test, maintain, and extend
- Type-checked with `mypy`, formatted with `ruff`

## Quick Start

### Prerequisites 📦
- Python 3.12+
- [uv](https://github.com/astral-sh/uv) package manager
- [GitLab CLI](https://gitlab.com/gitlab-org/cli) (`glab`) (for MR reviews)

### Installation ⚡

```bash
# From PyPI (recommended)
pip install diff-review-system

# Use the CLI
drs --help
# or
diff-review-system --help

# From source (dev)
git clone <repository-url>
cd drs
uv sync
uv run drs --help
```

## Usage 🚀

### Local Development Review
```bash
# Review current changes (staged + unstaged + untracked)
uv run drs --local

# Save review to file
uv run drs --local -o review.md
```

### GitLab Merge Request Review
```bash
# Review specific MR locally
uv run drs --mr-id 123

# Generate GitLab-compatible JSON
uv run drs --mr-id 456 --format gitlab-json -o code-quality.json
```

### CI/CD Integration
```yaml
# .gitlab-ci.yml
code_quality:
  stage: test
  script:
    - uv sync
    - uv run drs --format gitlab-json -o gl-code-quality-report.json
  artifacts:
    reports:
      codequality: gl-code-quality-report.json
```

## Architecture 🏗️

```
drs/
    main.py               # CLI entry point (~45 lines)
    context.py            # Context detection (~130 lines)
    claude_integration.py # Claude SDK integration (~110 lines)
    reviewer.py           # Review orchestration (~65 lines)

.claude/
    agents/
        code-reviewer.md # Specialized review subagent
```

### How It Works 🛠️

1. **Context Detection** – Determines review environment
2. **Git Command Generation** – Creates appropriate git commands
3. **Subagent Invocation** – Calls the specialized code-reviewer
4. **Output Processing** – Formats results for the target environment

## Output Examples 🧪

### Text Format (Local Development)
```markdown
## Code Review Summary
Overall assessment: Good refactoring with some minor issues

## Issues Found

### MAJOR - Missing Type Annotations
**File:** `drs/main.py` (line 42)
**Category:** maintainability
**Description:** Function lacks type hints
**Recommendation:** Add type annotations for better IDE support
```

### GitLab JSON Format (CI/CD)
```json
[
  {
    "description": "Missing type annotations. Add type hints for better IDE support.",
    "check_name": "maintainability",
    "fingerprint": "a1b2c3d4e5f6",
    "severity": "major",
    "location": {
      "path": "drs/main.py",
      "lines": { "begin": 42 }
    }
  }
]
```

## Development 👩‍💻

### Setup Development Environment 🧰
```bash
# Install with dev dependencies
uv sync --extra dev

# Run tests
uv run ruff check
uv run mypy drs/

# Format code
uv run ruff check --fix
```

### Project Commands 🏃
```bash
# CLI help
uv run drs --help

# Test different contexts
uv run drs --local --format text
uv run drs --mr-id 123 --format gitlab-json

# Context testing
CI=true CI_PIPELINE_SOURCE=merge_request_event \
  CI_MERGE_REQUEST_ID=123 \
  CI_MERGE_REQUEST_TARGET_BRANCH_NAME=main \
  uv run drs --format gitlab-json
```

## Key Advantages 🌟

### Over Traditional SAST Tools 🆚
- **Context Awareness**: Understands your workflow
- **Semantic Analysis**: Goes beyond pattern matching
- **No (or fewer) False Positives**: AI-powered relevance filtering

### Over Manual Code Review 🙋
- **Consistency**: Same quality standards every time
- **Speed**: Instant feedback on changes
- **Integration**: Seamless CI/CD workflow

### Technical Excellence 🛠️
- **No Redundant Operations**: Single git command execution
- **Proper MR Scope**: Reviews all commits vs target branch
- **Direct JSON Output**: No fragile regex parsing
- **Modular Architecture**: Easy to maintain and extend

## Documentation 📚

- **[CLAUDE guide](CLAUDE.md)**: Comprehensive project documentation
- **[Claude agents directory](/.claude/agents/)**: Subagent configurations
- **Code Comments**: Inline documentation throughout

## Contributing 🤝

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `uv run ruff check && uv run mypy drs/`
5. Submit a pull request

## License 📄

[MIT License](LICENSE)

— Happy reviewing! 🎉
