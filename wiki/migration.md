---
type: Operations
title: Migrating from DRS 4.1 to 5.0
description: Required changes and behavioral differences when upgrading from DRS 4.1 to 5.0, including removed commands, the CLI-only package, split GitHub review posting, and changed defaults.
tags: [migration, upgrade, breaking-changes, 5.0]
drs_sources:
  - path: docs/MIGRATING_TO_5.md
  - path: CHANGELOG.md
  - path: docs/RELEASING.md
---

# Migrating from DRS 4.1 to 5.0

DRS 5.0 formalizes the npm package as a CLI-only application, removes bundled skill synchronization, hardens the external-review trust boundary, and changes several defaults. Projects upgrading from 4.1 should review `docs/MIGRATING_TO_5.md` before changing production workflows.

## Removed commands and skill ownership

The following commands were removed:

- `drs skills list`
- `drs skills status`
- `drs skills install`
- `drs skills sync`
- `drs sync`

DRS no longer installs or synchronizes bundled skills and no longer maintains `.drs/skills-lock.json`. Project-authored skills remain supported and are discovered from `.drs/skills`, `.agents/skills`, and `.pi/skills` (in that order) when `agents.paths.skills` is not configured. See [Pi runtime and agents](pi-runtime.md) for skill discovery and override order.

## CLI-only package

The npm package is explicitly CLI-only. The package-root `main` declaration was removed, and programmatic imports from package internals or `dist/` are unsupported. Automations should invoke the CLI instead of importing deep helpers.

## GitHub review posting

`github-pr-review-post` is now a deterministic, model-free consumer of a canonical review artifact. It requires the exact reviewed head SHA (`expectedHeadSha`) and validates scope, head, findings, fingerprints, counts, and changed paths before posting. For one-command review and posting, run `github-pr-review` with `describe=true` and `post=true`.

The split-job external PR path uses a trusted-base, read-only model job that exports only the scoped `review/latest.json` artifact, and a separate posting job without provider credentials. See [Platform integrations](integrations.md) and `docs/EXTERNAL_PR_SECURITY.md`.

## Agent permissions and concurrency

Packaged review model sessions run with repository-wide read access and no shell or filesystem mutation tools. Actions and agents that can mutate the workspace are serialized within a wave; add explicit `needs` edges where ordering matters.

## Commit attribution

Packaged GitHub and GitLab fix and agent-guidance workflows default `useChangeRequestAuthor` to `true`, attributing generated commits to the change-request creator. Set the input to `false` when push rules require the automation identity.

## JSON and artifact contracts

`drs doctor --json` no longer reports bundled-skill status. Workflow JSON output includes additive fields such as `usage`, `workspaceChanges`, and `permissions`. The canonical review artifact enforces size and count limits: 5 MiB artifact, 1,000 findings, 100 inline comments, 60,000-character summary/comments, 20,000-character problem/solution text, and smaller caps on metadata fields.

## Release automation

DRS maintainers must not create release tags manually. The release workflow validates exact SemVer, updates `package.json` and `package-lock.json`, finalizes the changelog, refreshes the wiki, and applies an atomic commit/tag transaction. See `docs/RELEASING.md` and [Maintenance workflows](maintenance-workflows.md).

## Verification checklist

After upgrading configuration and workflows:

```bash
drs doctor --json
drs workflow validate
drs workflow list
```

Then run representative workflows in a non-production project, generating artifacts with `post=false` before enabling posting.

## See also

- [Quickstart](quickstart.md) for current CLI commands and supported workflows.
- [Configuration](configuration.md) for `agents.paths.skills`, `review.agents`, and model settings.
- [Review workflows](review-workflows.md) for review artifacts and fix flows.
- [Maintenance workflows](maintenance-workflows.md) for changelog and release workflows.
- [Platform integrations](integrations.md) for GitHub Actions and GitLab CI wrappers.
