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
