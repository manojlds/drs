# Pi Migration, Upgrade, and Validation Guide

This guide covers migration from legacy OpenCode-based setups to the Pi-based DRS runtime.

## What Changed (Breaking Changes)

1. **Pi is now the only runtime**
   - DRS review execution runs through Pi SDK.
   - OpenCode runtime code paths and dependencies were removed.

2. **Runtime endpoint variable is now `PI_SERVER`**
   - `PI_SERVER` is the primary environment variable.
   - `OPENCODE_SERVER` is accepted as a temporary legacy alias for compatibility.

3. **Runtime config key is now `pi`**
   - Use:
     ```yaml
     pi:
       serverUrl: http://localhost:3000
     ```
   - Legacy `opencode` config is normalized internally for backward compatibility, but new configs should use `pi`.

4. **Built-in assets are Pi-native**
   - Built-in agents are under `.pi/agents/*`.
   - Skill discovery defaults to:
     1. `.drs/skills` (project overrides)
     2. `.pi/skills` (fallback)

## Upgrade Steps

1. **Upgrade DRS**
   ```bash
   npm install -g @diff-review-system/drs@latest
   ```

2. **Update runtime environment**
   - Prefer `PI_SERVER` if you run an external runtime.
   - Keep it unset for in-process runtime.

3. **Update configuration keys (if needed)**
   - Move runtime config to `pi.serverUrl`.
   - Keep review settings under `review.*`.

4. **Verify model provider credentials**
   - Set one provider key such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `ZHIPU_API_KEY`.

5. **Run a smoke review for each flow**
   ```bash
   drs review-local --staged
   drs review-mr --project org/repo --mr 123
   drs review-pr --owner octocat --repo hello-world --pr 456
   ```

6. **Run full quality gates**
   ```bash
   npm run check:all
   ```

## End-to-End Validation Coverage

The following review flows are validated through CLI-focused tests in this repository:

| Flow | Validation Coverage | Primary Tests |
|---|---|---|
| `review-local` | Local git diff flow, ignore/filter behavior, JSON output, blocking exit behavior | `src/cli/review-local.test.ts`, `src/lib/review-orchestrator.test.ts` |
| `review-mr` | GitLab MR context load, diff-aware line validation, inline position mapping, platform error mapping | `src/cli/review-mr.test.ts`, `src/lib/unified-review-executor.test.ts` |
| `review-pr` | GitHub PR context load, diff-aware line validation, inline position mapping, platform error mapping | `src/cli/review-pr.test.ts`, `src/lib/unified-review-executor.test.ts` |

Repository-wide validation command:

```bash
npm run check:all
```

## Pi Setup and Configuration Checklist

- [ ] Node.js 20+
- [ ] DRS installed (`npm i -g @diff-review-system/drs`)
- [ ] `.drs/drs.config.yaml` configured with `review.*` settings
- [ ] Provider API key exported
- [ ] `GITLAB_TOKEN` set for MR reviews
- [ ] `GITHUB_TOKEN` set for PR reviews
- [ ] Optional `PI_SERVER` set only when using an external runtime

## Troubleshooting

### Authentication failures
- Verify token/API-key scope and expiration.
- Confirm environment variables are present in the executing shell/CI job.

### Runtime connectivity failures
- If using `PI_SERVER`, verify endpoint reachability and DNS/network access.
- Unset `PI_SERVER` to verify local in-process fallback.

### Missing/invalid agent or skill path
- Verify `review.paths.agents` / `review.paths.skills` paths exist.
- Prefer repo-relative paths for reproducible CI behavior.

### No findings or no comments posted
- Run with `--debug` and inspect loaded files/agents.
- Verify changed files are not excluded by `review.ignorePatterns`.
- Verify posting flags (`--post-comments`, `--post-description`) and platform token permissions.
