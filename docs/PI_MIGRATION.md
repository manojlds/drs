# Pi Migration, Upgrade, and Validation Guide

This guide covers migration from legacy OpenCode-based setups to the Pi-based DRS runtime.

## What Changed (Breaking Changes)

1. **Pi is now the only runtime**
   - DRS review execution runs through Pi SDK.
   - OpenCode runtime code paths and dependencies were removed.

2. **DRS uses Pi in-process runtime only**
   - Remote runtime endpoints are not supported.
   - Legacy endpoint settings (`PI_SERVER`, `pi.serverUrl`) are ignored.

3. **Runtime config key is `pi`**
   - Use `pi` for provider/runtime options that apply to in-process execution.
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

2. **Remove legacy runtime endpoint settings**
   - Remove `PI_SERVER` from local shells and CI variables.
   - DRS runs Pi in-process and does not use remote runtime endpoints.

3. **Update configuration keys (if needed)**
   - Keep runtime/provider settings under `pi`.
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
| `review-local` | Local git diff flow, ignore/filter behavior, JSON output, blocking exit behavior, simulated-diff integration path | `src/cli/review-local.test.ts`, `src/cli/review-local.integration.test.ts`, `src/lib/review-orchestrator.test.ts` |
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
- [ ] No legacy runtime endpoint variables (`PI_SERVER`) are set

## Troubleshooting

### Authentication failures
- Verify token/API-key scope and expiration.
- Confirm environment variables are present in the executing shell/CI job.

### Runtime connectivity failures
- DRS runs Pi in-process; there is no remote runtime endpoint to configure.
- Ensure provider API keys are available and valid in the current shell/CI job.

### Missing/invalid agent or skill path
- Verify `review.paths.agents` / `review.paths.skills` paths exist.
- Prefer repo-relative paths for reproducible CI behavior.

### No findings or no comments posted
- Run with `--debug` and inspect loaded files/agents.
- Verify changed files are not excluded by `review.ignorePatterns`.
- Verify posting flags (`--post-comments`, `--post-description`) and platform token permissions.
