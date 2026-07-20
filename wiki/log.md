# Wiki update log

## 2026-07-18

Generated the initial DRS repository wiki bundle under `wiki/` and then reconciled it for the final OKF repository wiki feature delta after hardening.

Initial concept pages created:

- `quickstart.md` — entry point and orientation.
- `architecture.md` — system architecture and layers.
- `pi-runtime.md` — in-process Pi runtime, agents, models, and skills.
- `workflow-engine.md` — workflow DSL, planning, compilation, and execution.
- `review-workflows.md` — review workflows, findings, fix verification, and posting.
- `maintenance-workflows.md` — changelog, fix, and agent-guidance workflows.
- `configuration.md` — `.drs/drs.config.yaml`, environment variables, and legacy migrations.
- `integrations.md` — GitHub, GitLab, and CI/CD integration.
- `temporal-execution.md` — Temporal durable execution backend.
- `testing.md` — tests, quality gate, and smoke coverage.

All concept pages include YAML frontmatter and Markdown relationship links to related concepts. DRS generated `index.md` deterministically after concept generation.

Hardening updates:

- Added [repository-wiki.md](repository-wiki.md) documenting the `repository-wiki-sync` and `repository-wiki-check` workflows, deterministic aggregate and per-path delta fingerprints (`src/lib/wiki-delta.ts`), stable deletion/rename and clean-submodule handling, dirty-submodule rejection, literal path checks, symlink safety, ignored-output detection, the model-free CI check, OKF v0.1 bundle validation, index synchronization, and related tests.
- Updated [quickstart.md](quickstart.md) with repository wiki commands and a link to the new concept.
- Updated [workflow-engine.md](workflow-engine.md) to list the OKF/wiki actions.
- Updated [maintenance-workflows.md](maintenance-workflows.md) to include the repository wiki workflows and link to the detailed concept.
- Updated [testing.md](testing.md) to cover `src/lib/okf-wiki.test.ts`, `src/lib/wiki-delta.test.ts`, and the wiki workflow tests in `src/cli/workflow.test.ts`.
- Updated [temporal-execution.md](temporal-execution.md) to note that `sync-okf-indexes` and `record-wiki-state` are no-retry side effects and that `repository-wiki-sync` remains local-executor-only.
- Added the human-readable VitePress publishing layer, including OKF-derived navigation and metadata, local search, raw bundle and `llms.txt` outputs, pull-request build validation, and GitHub Pages deployment.
- Dogfooded a 13-path deterministic delta to add the internal-link concept graph, reusable `drs wiki build`, `drs wiki serve`, and `drs wiki check-site` commands, and a post-deployment Pages smoke check.
- Hardened the reusable renderer with OKF preflight validation, symbolic-link and concurrent-operation guards, generic start/log handling, canonical Pages metadata, structured graph smoke validation, and npm-package output exclusions.

## 2026-07-19

Updated [integrations.md](integrations.md) and [repository-wiki.md](repository-wiki.md) to reflect changes in `.github/workflows/pr-review.yml`:

- Trusted contributor reviews now synchronize the repository wiki, stage only `wiki/` and `.drs/wiki-state.json` changes, and push them back to the PR branch with a guarded patch and `force-with-lease` against the reviewed head.
- External contributor reviews require both the `safe-to-review` label and approval of the `external-pr-review` environment.
- Documented `git-commit` `useChangeRequestAuthor` in [workflow-engine.md](workflow-engine.md), including public email fallback, platform no-reply synthesis, `source` override, and pre-staging validation.
- Updated [integrations.md](integrations.md) with the `authorEmail` field on `PullRequest` and adapter email normalization.
- Noted creator attribution in review fix flows and stacked agent-guidance workflows in [review-workflows.md](review-workflows.md) and [maintenance-workflows.md](maintenance-workflows.md).
- Confirmed trusted same-repository PR wiki synchronization details in [repository-wiki.md](repository-wiki.md) and [integrations.md](integrations.md), including `--executor local` and the `DRS_PROVIDER_API_KEY` / `OPENCODE_API_KEY` fallback resolution.
- Updated [testing.md](testing.md) to cover the new platform adapter and `git-commit` tests.
- Updated [integrations.md](integrations.md) for the latest `pr-review.yml` workflow structure: job-level split (`verify-contributor`, `review-trusted`, `sync-wiki-trusted`, `commit-wiki-trusted`, `review-external`, `notify-external`), different review flags for trusted vs external PRs, and the dual-gate external approval (`safe-to-review` label plus `external-pr-review` environment).

Follow-up delta: applied `useChangeRequestAuthor: true` to every `git-commit` node in the packaged fix and guidance workflows (`github-pr-review`, `gitlab-mr-review`, `github-pr-fix-review-issues-stacked`, `gitlab-mr-fix-review-issues-stacked`, `github-pr-update-agents-md-stacked`, `gitlab-mr-update-agents-md-stacked`). Added `src/gitlab/client.test.ts` to cover `resolveGitLabCommitEmailDomain`. Updated [review-workflows.md](review-workflows.md) to note the standalone stacked fix workflows.

Added model-free repository wiki retrieval through `drs wiki search`. Updated [quickstart.md](quickstart.md), [repository-wiki.md](repository-wiki.md), and [testing.md](testing.md) for deterministic metadata/body ranking, safe OKF loading, repository-relative citations, snippets, result limits, and JSON output. Cited the search implementation paths (`src/cli/wiki.ts`, `src/lib/wiki-search.ts`, `src/lib/okf-wiki.ts`) in [repository-wiki.md](repository-wiki.md).

Updated [architecture.md](architecture.md) to include the `wiki` top-level command group alongside `workflow`, `temporal`, `run-agent`, and the project-setup commands, and described its `search`, `build`, `serve`, and `check-site` subcommands.

Hardened `drs wiki search` and its tests in `src/lib/wiki-search.ts` and `src/lib/wiki-search.test.ts`:

- Confirmed ranking weights metadata (title, tags, description, headings) above body text and boosts complete phrase matches and exact title hits.
- Verified that heading extraction ignores fenced code blocks (both ` ``` ` and `~~~`), so shell comments and code examples are not treated as document structure.
- Added rejection of empty/whitespace-only queries and non-positive-integer limits with clear error messages.
- Confirmed symlink rejection and unsafe-root validation are exercised by the search path through `loadOkfConcepts`.
- Updated [repository-wiki.md](repository-wiki.md) to describe the ranking, snippet selection, and validation behavior in more detail.

Follow-up search hardening in `src/lib/wiki-search.ts` and `src/lib/wiki-search.test.ts`:

- Documented Unicode NFKC normalization and code-point-safe snippet excerpting in [repository-wiki.md](repository-wiki.md).
- Documented invalid backtick-fence handling (info strings containing embedded backticks) so headings inside them remain searchable.
- Updated [testing.md](testing.md) to list the new Unicode snippet and invalid-fence test cases.

Replaced per-feature-PR repository wiki synchronization with a scheduled GitHub workflow that maintains one `drs/wiki-update` pull request from the latest default branch. Ordinary feature PRs now validate the OKF bundle through the site build without committing branch-specific wiki state; the bot PR retains the strict model-free freshness check. Updated [repository-wiki.md](repository-wiki.md), [integrations.md](integrations.md), and [maintenance-workflows.md](maintenance-workflows.md) with the scheduling, token isolation, and merge-consistency behavior.

Removed the obsolete bundled skill installation and synchronization commands from [architecture.md](architecture.md). Project-authored skills and runtime skill discovery remain supported.

## 2026-07-20

Added generic workflow-agent filesystem permissions and applied them to repository wiki maintenance.

Core changes:

- Workflow nodes can now declare `permissions` and `validation` fields. `permissions` supports `read`, `write`, and `delete` rules with literal repository-relative `roots`, root-relative `allow`/`deny` glob patterns, and mandatory `shell: false`. `validation.afterMutation` currently supports the `okf-document` validator, which checks proposed OKF documents before writes and returns full bundle validation feedback after mutations. `src/lib/config.ts` and `src/lib/workflow/planning.ts` validate these fields and reject forbidden combinations such as `permissions` with `writes`, `agentsFrom` write/delete permissions, or validators without write/delete access.
- `src/lib/agent-permissions.ts` implements the filesystem authorizer, workspace snapshot capture, and post-run mutation guard. It rejects traversal, symbolic links, and multiply-linked write targets; fingerprints tracked and non-ignored untracked files before and after the run; and reports residual changes outside the allowed policy.
- `src/pi/sdk.ts` installs policy-aware versions of Pi's `read`, `write`, `edit`, and `delete_file` tools, applies the authorizer to DRS custom tools, removes unrestricted `bash`/`drs_check` from scoped sessions, and disables Pi resource-loader extensions when permissions are active.
- `src/cli/run-agent.ts` captures a workspace snapshot before a restricted agent runs and asserts that only allowed paths changed afterwards.
- `src/cli/workflow.ts` and `src/temporal/workflows.ts` serialize nodes that are potential workspace mutations (`isPotentialWorkspaceMutation`) so concurrent filesystem edits cannot collide. `src/temporal/retry-policy.ts` classifies agent nodes with `write`/`delete` permissions as no-retry, alongside fixed `writes` paths.
- The `repository-wiki-sync` workflow (`src/pi/workflows/repository-wiki-sync.yaml`) now applies scoped permissions and `okf-document` validation to the `task/okf-wiki-maintainer` agent. The agent frontmatter (`src/pi/agents/task/okf-wiki-maintainer.md`) disables shell, enables `delete_file`, and keeps `git_diff` for source evidence.
- `src/lib/okf-wiki.ts` gained `validateOkfDocument` for pre-mutation checks, atomic index writes via temporary-file rename, removal of stale empty-directory indexes, and directed concept-graph metrics (node count, directed edges, orphans, weakly connected concepts) returned from `validateOkfBundle`.
- `.wiki-site/.vitepress/config.mts` now links `graph.html` with the absolute site URL and strips a leading BOM when parsing frontmatter.
- `src/lib/skills.ts` and the bundled skill installation/sync commands (`drs skills`, `drs sync`) were removed; project-authored skill directories under `.drs/skills`, `.agents/skills`, and `.pi/skills` are still discovered by the runtime if present.
- Added `markdown-it` and `minimatch` dependencies.

Updated concepts:

- [workflow-engine.md](workflow-engine.md) — added agent permission example, node-field restrictions, and workspace-mutation serialization.
- [pi-runtime.md](pi-runtime.md) — described policy-aware tool enforcement, `noExtensions`, custom-tool authorization, and validator feedback.
- [temporal-execution.md](temporal-execution.md) — noted wave serialization for workspace mutations and permission-based no-retry classification.
- [repository-wiki.md](repository-wiki.md) — documented atomic index writes, empty-index cleanup, and the maintainer's permission boundary.
- [maintenance-workflows.md](maintenance-workflows.md) — noted the scoped permissions and in-run validation on `repository-wiki-sync`.
- [testing.md](testing.md) — listed the new planning, permission, and wiki-site integration tests.
