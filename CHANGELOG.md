# Changelog

All notable changes to DRS are documented in this file.

## 4.0.1 - 2026-06-28

### Added

- Introduce workflow-first CLI: `drs workflow run <name>` runs packaged or project-defined DAG workflows, and `drs run-agent` (alias `drs run`) executes any configured agent by id.
- Add packaged review workflows: `local-review`, `github-pr-review`, and `gitlab-mr-review`, with inputs for staged review, posting descriptions, posting comments, and GitLab Code Quality output.
- Add packaged review context workflows: `github-pr-show-changes` and `gitlab-mr-show-changes`.
- Add `drs workflow list` to show available workflows with packaged/project source and override status.
- Add packaged description workflows: `github-pr-describe` and `gitlab-mr-describe`, with `post=true` for updating PR/MR descriptions.
- Add packaged maintenance workflows: `local-changelog-update`, `tag-changelog-update`, `local-fix-review-issues`, `local-update-agents-md`, and project-local `local-changelog-review`.
- Add built-in maintenance agents: `task/changelog-updater`, `task/review-issue-fixer`, and `task/agents-md-updater`.
- Add workflow actions: `change-source`, `review`, `review-context`, `describe`, `code-quality-report`, `post-comment`, `post-review-comments`, `write`, `git-diff`, `git-add`, and `git-commit`.
- Support workflow inputs, dependency graphs, concurrent nodes, and `{{inputs}}`/`{{artifacts}}`/`{{nodes}}` templates.
- Add top-level `agents` config with `default`, `namespaces`, and `overrides` for model, skills, tools, and run settings.
- Add runtime timeout and provider retry controls (`pi.runtime.*`, `pi.retry.provider.*`) with `DRS_RUNTIME_*` environment overrides.
- Include reviewed commit SHA and branch metadata in posted review summary comments.
- Add `docs/WORKFLOWS.md` with the full workflow configuration reference.
- Expose `output.updatedIds` on `review-artifact-update-findings` and `verify-fix` for fix-verification reconciliation reporting.
- Validate every workflow node's `action` value at config load time with did-you-mean suggestions for near-miss typos.
- Add a manual pre-tag release changelog workflow and packaged `release-changelog-finalize` workflow so final release tags can include the finalized changelog before npm publish.

### Changed

- Reposition DRS as a workflow-first AI code maintenance runtime; review is now a packaged workflow family instead of hard-coded CLI commands.
- Replace legacy `review-local`, `review-pr`, `review-mr`, `review-url`, `describe-pr`, and `describe-mr` commands with workflow-based equivalents.
- Adopt fully qualified agent ids (`<namespace>/<name>`); the default review agent is now `review/unified-reviewer`.
- Move agent defaults and search paths from `review.default`/`review.paths` to the top-level `agents` config.
- Move default model configuration from `review.default.model`/`REVIEW_DEFAULT_MODEL` to `agents.default.model`/`DRS_DEFAULT_MODEL`.
- Update the CLI banner, help text, and package metadata for the 4.0.0 breaking release.
- Update GitHub Actions and GitLab CI templates to run packaged workflows.
- Upgrade bundled Pi SDK to 0.73.1.
- Document workflow-first 4.0 configuration and clarify that `switch` and `passThrough` are forward-only routers.

### Fixed

- Fix GitLab stacked-mode fix status dependencies so stacked fix MRs notify after creation.
- Reject non-loop backward workflow control routes at validation/runtime to prevent unbounded graph jumps.
- Exclude compiled test files from the published npm package while preserving packaged `.pi` agents and workflows.

### Removed

- Remove packaged standalone review agents (`security`, `quality`, `style`, `performance`, `documentation`) in favor of `review/unified-reviewer` and project-specific `review/*` agents.
- Remove `review.postErrorComment` and `review.describe.postDescription` config keys; posting is now explicit via workflows.
- Remove the standalone `post-comments` CLI command; use review-post workflows or `post-review-comments` workflow actions instead.
- Remove the standalone `show-changes` CLI command; use `github-pr-show-changes` or `gitlab-mr-show-changes` workflows instead.
- Remove inline `workflows:` map support in `.drs/drs.config.yaml`; workflows must be defined as separate files under `.drs/workflows/*.yaml`.
- Remove migration-only `REVIEW_MODE` and `REVIEW_UNIFIED_THRESHOLD` env-var handlers and related validation warnings. Compatibility aliases for `REVIEW_AGENTS`, `REVIEW_DEFAULT_MODEL`, and `REVIEW_AGENT_<ID>_MODEL` remain supported.
- Remove inert 3.x review schema fields that no production runtime path reads (`mode`, `unified.severityThreshold`, and related types).
- Remove the exported `runUnifiedReviewAgent` helper; workflow-first review runs through the normal review pipeline.
- Move ad-hoc release-prep helper scripts out of tracked source.

## 3.3.1 - 2026-05-04

### Changed

- Remove obsolete Vaibhav/Ralph project artifacts and stale repository references.
- Remove direct `@anthropic-ai/sdk` dependency and rely on Pi's transitive SDK dependency.

### Fixed

- Fail review execution when configured skills are missing, with an explicit error that includes searched skill paths.

## 3.3.0 - 2026-05-03

### Added

- Add opt-in `Fix in Cursor` links to posted review summary and inline issue comments.
- Add `review.cursorFixLinks` config with optional `workspace` routing.
- Add `--fix-in-cursor` and `--skip-fix-in-cursor` CLI overrides for review and comment-posting flows.

### Changed

- Use Cursor's HTTPS prompt deeplink bridge so hosted PR/MR platforms preserve review comment links.
- Enable Cursor fix links for this repository's DRS config.
- Switch this repository's review and description models to `opencode-go/glm-5`.

### Fixed

- Make `post-comments` honor configured Cursor fix link defaults and workspace settings.
- Sanitize additional hidden Unicode separators before embedding review issue text in Cursor prompts.
