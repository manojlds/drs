---
okf_version: "0.1"
---

# Concepts

* [DRS architecture](architecture.md) - High-level system architecture of DRS — CLI, workflow engine, runtime, agents, and platform integrations.
* [DRS configuration](configuration.md) - How DRS loads configuration from .drs/drs.config.yaml, environment variables, and CLI overrides.
* [Platform integrations](integrations.md) - How DRS integrates with GitHub, GitLab, and CI/CD systems.
* [Maintenance workflows](maintenance-workflows.md) - DRS workflows for repository upkeep — changelog updates, review-issue fixes, agent guidance refresh, and release changelog finalization.
* [Pi runtime and agents](pi-runtime.md) - How DRS runs the Pi SDK in-process, discovers agents, resolves models, attaches skills, and exposes custom tools.
* [DRS repository wiki](quickstart.md) - Entry point for the DRS wiki. Learn what DRS does, how it is organized, and where to find the key concepts.
* [Repository wiki](repository-wiki.md) - Generate and maintain an OKF v0.1 repository wiki bundle with deterministic delta fingerprints, model-free checks, and CI validation.
* [Review workflows](review-workflows.md) - How DRS performs code reviews from local diffs, GitHub PRs, and GitLab MRs, including change sources, findings, fix verification, and posting.
* [Temporal execution](temporal-execution.md) - Durable workflow execution through Temporal, including worker deployment, workspace modes, and queries.
* [Testing and quality gate](testing.md) - How DRS is tested, including the mandatory quality gate, unit tests, live tests, and Temporal smoke tests.
* [Workflow engine](workflow-engine.md) - How DRS compiles, validates, schedules, and executes YAML workflows, including built-in actions and control nodes.
