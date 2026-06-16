# CLAUDE.md — DRS Quick Context

## Project Context

**DRS (Diff Review System)** is a workflow-first AI code maintenance tool for:
- GitLab Merge Request workflows
- GitHub Pull Request workflows
- Local diff review and maintenance workflows
- Agentic repository upkeep such as changelog, review-fix, and agent guidance updates

### Stack
- Node.js + TypeScript
- Pi SDK (`@mariozechner/pi-coding-agent`) running **in-process**
- Vitest for tests

### Important Paths
- `src/cli/` — CLI commands (`workflow run`, `post-comments`, `show-changes`, `run-agent`)
- `src/lib/` — core review orchestration/utilities
- `src/runtime/` — runtime client + agent loading
- `src/pi/` — Pi SDK adapter
- `.pi/agents/review/` — built-in review agents
- `.pi/agents/task/` — built-in maintenance agents
- `.pi/workflows/` — packaged workflows
- `.drs/drs.config.yaml` — project config

---

## Dev Commands

### Setup
```bash
npm install
```

### Build / Test
```bash
npm run build
npm test
npm run type-check
```

### Local Run
```bash
npm run dev -- workflow run local-review
npm run dev -- workflow run gitlab-mr-review --input project=org/repo --input mr=123
npm run dev -- workflow run github-pr-review --input owner=user --input repo=repo --input pr=456
```

### Mandatory Quality Gate (after every code change)
```bash
npm run check:all
```

This runs format + lint + build + test + verification checks.
