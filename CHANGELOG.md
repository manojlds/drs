# Changelog

All notable changes to DRS are documented in this file.

## Unreleased

### Added

- Add the packaged `repository-wiki-sync` workflow and `task/okf-wiki-maintainer` agent for generating and maintaining one repository wiki as an official OKF v0.1 bundle.
- Add `sync-okf-indexes` and `validate-okf-wiki` workflow actions for deterministic progressive-disclosure indexes and bundle conformance validation.
- Add source/wiki fingerprints, persisted delta state, model-free no-op and PR checks, and changed-path-scoped wiki maintenance.
- Add an OKF-aware VitePress website with local search, concept metadata, raw bundle and `llms.txt` outputs, PR build validation, and GitHub Pages deployment.
- Add an interactive internal-link concept graph, reusable `drs wiki build`, `drs wiki serve`, and `drs wiki check-site` commands, and post-deployment Pages smoke checks.
- Add scheduled repository wiki synchronization through a dedicated bot pull request.
- Add model-free `drs wiki search` with deterministic metadata/body ranking, repository-relative citations, snippets, limits, and JSON output.
- Add generic workflow-agent filesystem permissions with literal roots, allow/deny patterns, shell isolation, Pi-native tool enforcement, post-run mutation checks, and in-run content validators.
- Add a persistent repository wiki brief at `.drs/wiki-instructions.md`: the `repository-wiki-sync` workflow loads it on every run, appends any one-run `instructions` input with explicit precedence, exposes the effective instructions source and hash in JSON output, and reconciles the wiki when the brief changes. One-run inputs are never recorded in wiki state and never invalidate freshness.
- Add structured source provenance for repository wiki concepts: declare `drs_sources` citations in concept frontmatter, keep a `source path -> concept paths` reverse map in wiki state, scope update runs to `candidateConcepts` whose cited sources changed, render a Sources panel on the wiki site, and expose citations in `drs wiki search --json`. Malformed declarations fail validation; missing cited paths and missing provenance are warnings so coverage grows incrementally.
- Add deterministic repository wiki run summaries with delta and concept-change counts, validation, graph and provenance metrics, model usage and estimated cost, elapsed time, and explicit model-free no-op reporting. Human and JSON workflow output share the summary; scheduled wiki updates publish escaped Markdown to the GitHub job summary and reusable wiki pull request body without adding comments.
- Add exact SemVer/date/package/changelog validation and documented recovery for release automation.

### Changed

- Preserve directed concept links in repository wiki graphs, show incoming and outgoing relationships separately, and report deterministic orphan and weak-connection quality metrics during validation.
- Run repository wiki maintenance with scoped Markdown writes, generated-index denial, no shell access, and immediate OKF validation feedback.
- Declare the npm distribution as CLI-only, expose `useChangeRequestAuthor` inputs on packaged fix/guidance workflows, update Pi to 0.79.10 and Temporal to 1.20.3, and pin patched transitive dependencies where supported.
- Repurpose `github-pr-review-post` as a model-free canonical-artifact posting workflow that requires the exact reviewed head SHA; use `github-pr-review` with `describe=true` and `post=true` for one-step review and posting.
- Run packaged GitHub review model sessions with repository-read-only access and no shell, and serialize workflow nodes that may mutate the workspace.
- Attribute commits from packaged PR/MR fix and agent-guidance workflows to the change-request creator by default; set `useChangeRequestAuthor=false` when push rules require the automation identity.
- Remove bundled-skill details from `doctor --json`, add per-agent usage and optional workspace-change details to workflow JSON, and strictly validate canonical artifact scope and contents before posting.
- Reject oversized review artifacts and platform comments before mutation, with bounded finding and inline-comment counts.

### Fixed

- Harden reusable wiki rendering against symbolic-link escapes and overlapping in-process operations, support valid bundles without DRS-specific quickstart/log pages, and exclude generated site output from the npm package.
- Preserve `temporal` settings loaded from `.drs/drs.config.yaml` instead of silently dropping them during config merge.
- Isolate external GitHub PR model execution from write credentials and PR-controlled code by using trusted base checkouts, read-only review permissions, a canonical artifact handoff, and strict scope/head/finding validation before deterministic posting.
- Commit package, changelog, and wiki metadata before atomically creating a release tag, then explicitly dispatch npm publication against that immutable tag and commit instead of relying on suppressed or racing tag-push workflows.
- Finalize release changelog headings and cumulative prerelease entries deterministically instead of depending on a live model request.

### Removed

- Remove bundled skill installation and synchronization commands, content lock tracking, and the obsolete top-level `drs sync` command now that DRS no longer packages skills. Project-authored agent skills remain supported.

### Documentation

- Add a [5.0 migration guide](docs/MIGRATING_TO_5.md) covering removed commands, configuration cleanup, workflow trust boundaries, changed defaults, and JSON contracts.

## 4.1.0 - 2026-07-17

### Added

- Add experimental Temporal execution backend. Run workflows through Temporal with `drs workflow run <name> --executor temporal`, start workers with `drs temporal worker`, and configure the backend in `.drs/drs.config.yaml`.
- Add `CompiledWorkflowPlan` abstraction and executor selection so `drs workflow run` can dispatch through a local or Temporal backend without changing workflow definitions.
- Add `drs workflow graph <name>` to print workflow dependency and control-flow graphs as text, JSON, or Mermaid.
- Add workflow `metadata` (kind, tags, review source/diff/issues) to packaged review, fix, and visual-explain workflows.
- Add `temporal-control-smoke` workflow for safe local Temporal control-flow testing.
- Add bundled `task/review-assistant` agent for conversational questions about review and workflow artifacts.
- Add skill management commands: `drs skills list`, `drs skills status`, `drs skills install`, and `drs skills sync`; install bundled skills under `.agents/skills` with a content lock file.
- Add `drs doctor` and `drs sync` commands for project setup checks and safe asset updates.
- Add `drs init --yes` and `--force` for non-interactive project initialization.
- Add `mise.toml` with Node 22.19.0 and common tasks.

### Changed

- Persist canonical review artifacts by default from the `review` action; expose them as `artifacts.<nodeId>Artifact` (e.g. `reviewArtifact`) instead of requiring an explicit `artifact` output name.
- Update packaged review, fix, and visual-explain workflows to use the canonical `reviewArtifact` name and declare workflow metadata.
- Prefer canonical review artifacts when parsing review output; remove legacy `.drs/review-output.json` file support and the `review_output` `write_json_output` type.
- Refactor workflow runtime behind a `WorkflowExecutor` interface with a `LocalWorkflowExecutor` and a `NodeExecutor` boundary to enable alternate backends.
- Move `AgentRunResult` to `src/lib/agent-result.ts` for shared use across CLI and workflow modules.
- Update skill search paths to include `.agents/skills` before `.drs/skills` and `.pi/skills`.
- Improve review agent failure messages to include per-agent error details.

### Fixed

- Fix review action to save the artifact envelope even when no explicit `artifact` output name is configured.
- Fix `post-comment` fallback marker to use the Temporal idempotency key when no explicit marker is configured.
- Fix review artifact payload validation to require a summary object.
- Fix `verify-fix` and internal fix loops to reference the canonical review artifact correctly.

### Documentation

- Add `docs/TEMPORAL.md` and `TEMPORAL_EXECUTION_PLAN.md` documenting the experimental Temporal executor, worker deployment, queries, troubleshooting, and rollout plan.
- Update `README.md` and `docs/WORKFLOWS.md` for Temporal mode, canonical review artifacts, and workflow metadata.

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
