# Wiki update log

## 2026-07-18

Generated the initial DRS repository wiki bundle under `wiki/`.

Concept pages created:

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
