# CLAUDE.md — DRS Quick Context

## Project Context

**DRS (Diff Review System)** is an AI-powered code review tool for:
- GitLab Merge Requests
- GitHub Pull Requests
- Local diff review

### Stack
- Node.js + TypeScript
- Pi SDK (`@mariozechner/pi-coding-agent`) running **in-process**
- Vitest for tests

### Important Paths
- `src/cli/` — CLI commands (`review-local`, `review-mr`, `review-pr`)
- `src/lib/` — core review orchestration/utilities
- `src/runtime/` — runtime client + agent loading
- `src/pi/` — Pi SDK adapter
- `.pi/agents/review/` — built-in review agents
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
npm run dev -- review-local
npm run dev -- review-mr --project org/repo --mr 123
npm run dev -- review-pr --owner user --repo repo --pr 456
```

### Mandatory Quality Gate (after every code change)
```bash
npm run check:all
```

This runs format + lint + build + test + verification checks.
