# Migrating From DRS 4.1 To 5.0

DRS 5.0 formalizes the npm package as a CLI application, removes bundled-skill synchronization, and tightens workflow execution and artifact posting. This guide covers changes that may require updates in projects using DRS 4.1.

## Before Upgrading

1. Record any local changes under `.agents/skills/` and inspect `.drs/skills-lock.json` if it exists.
2. Search scripts and CI configuration for `drs skills`, `drs sync`, `github-pr-review-post`, and imports from `@diff-review-system/drs` or its `dist/` directory.
3. Note any JSON fields consumed from `drs doctor --json` or `drs workflow run --json`.
4. Upgrade in a branch and validate every project workflow before running one that can post comments or modify files.

## Skill Ownership And Removed Commands

The following commands have been removed:

- `drs skills list`
- `drs skills status`
- `drs skills install`
- `drs skills sync`
- `drs sync`

DRS no longer installs or synchronizes bundled skills and no longer maintains `.drs/skills-lock.json`. Existing skill files are not deleted during upgrade. Review them, keep any project-authored content, and then archive or remove the obsolete lock file.

Project-authored skills remain supported. When `agents.paths.skills` is not configured, DRS searches these directories in order:

1. `.drs/skills/`
2. `.agents/skills/`
3. `.pi/skills/`

DRS 4.1 project initialization generated this override:

```yaml
agents:
  paths:
    skills: .agents/skills
```

Remove it to use the default multi-directory search. Keep it only when the project intentionally uses one custom skill directory; an explicitly configured directory must exist.

## CLI-Only Package

The npm package is now explicitly CLI-only. The invalid package-root `main` declaration was removed, and imports from package internals or `dist/` are unsupported.

Replace code such as:

```js
import { syncProjectSetup } from '@diff-review-system/drs/dist/lib/project-setup.js';
```

with CLI workflow or command invocation. There is no supported JavaScript API replacement for removed deep-import helpers such as skill synchronization or built-in skill path discovery.

## GitHub Review Posting

`github-pr-review-post` is now a deterministic, model-free consumer of an existing canonical review artifact. It no longer generates a description or review. It requires `expectedHeadSha`, validates the artifact against the current pull request, and then posts it. Its workflow output key changed from `review` to `postedReview`.

For the former one-command review and posting behavior, run:

```bash
drs workflow run github-pr-review \
  --input owner=<owner> \
  --input repo=<repo> \
  --input pr=<number> \
  --input describe=true \
  --input post=true
```

For an external pull request or another split-job setup:

1. Run `github-pr-review` with `post=false` and `requireCompleteDiff=true` in a trusted-base, read-only job.
2. Transfer only the scope-specific canonical `review/latest.json` artifact.
3. In a separate job without provider credentials, run `github-pr-review-post` with the exact reviewed head SHA as `expectedHeadSha`.

Do not edit or move the canonical envelope by hand. See the [External PR Security guide](EXTERNAL_PR_SECURITY.md) for the complete trust boundary.

## Agent Permissions And Concurrency

The packaged GitHub review model session now has repository-wide read access but no shell or filesystem mutation tools. Custom review agents used by that workflow must rely on the supplied change context and read-only repository tools.

If a trusted project-specific workflow genuinely needs shell or write access, define a project workflow override with an appropriate permission policy. Do not weaken the packaged external-PR path or expose project-controlled agents, configuration, or tools to a secret-bearing `pull_request_target` job.

DRS also serializes actions and agents that may mutate the workspace. Workflows must not depend on simultaneous writes. Add explicit `needs` edges where ordering matters, and place independent read-only agents in an earlier wave when Temporal throughput matters.

## Generated Commit Attribution

Packaged GitHub and GitLab fix and agent-guidance workflows now default `useChangeRequestAuthor` to `true`. Generated commits use the pull request or merge request creator as author and committer, while the authenticated token owner remains the pusher.

Disable this behavior when branch protection requires the automation identity's email:

```bash
drs workflow run <workflow> --input useChangeRequestAuthor=false
```

Self-managed GitLab installations can set `GITLAB_COMMIT_EMAIL_DOMAIN` when their private commit email domain differs from the inferred no-reply domain.

## JSON And Artifact Contracts

`drs doctor --json` no longer includes bundled-skill status. Its result is now:

```json
{
  "initialized": true,
  "configPath": ".drs/drs.config.yaml",
  "issues": []
}
```

Workflow JSON has additive fields. Agent node results include `usage`; permissioned mutating agents may include `workspaceChanges`; change-source metadata may include `pullRequest.authorEmail`; and workflow descriptions may include `permissions` and `validation`. JSON consumers should ignore unknown additive fields.

The canonical review schema remains version 1, but loading and posting now enforce stricter invariants:

- Review artifacts must not exceed 5 MiB.
- An artifact may contain at most 1,000 findings.
- A posted review may contain at most 100 inline comments.
- A posted summary or individual comment must not exceed 60,000 JavaScript characters.
- Finding `problem` and `solution` text is limited to 20,000 characters each, with smaller caps on metadata fields (title and agent 1,000, file path 4,096, id 100) and at most 100 references per finding.
- Scope, repository, change number, head SHA, changed paths, fingerprints, and summary counts must agree before any platform mutation.

These limits are not configurable. Bound custom reviewer output or consume the JSON through a project-specific integration when different limits are required.

## Copied GitHub Actions

Projects that copied the 4.1 external-PR workflow should replace it with the 5.0 trusted-base split-job design. Every fork is treated as external, including forks owned by collaborators. The model job has read-only credentials and produces one canonical artifact; a separate job validates and posts it without provider credentials.

The external path deliberately fails closed when GitHub cannot provide a stable and complete patch snapshot, including binary files or changes without a usable patch. There is no fallback that checks out and executes the pull request head.

## Source Repository Releases

DRS maintainers must not create release tags manually. The `Create release` workflow prepares package, lockfile, changelog, and wiki changes; verifies a hashed patch in a separate write job; atomically pushes the release commit and tag; and dispatches tag-bound CI, Pages, and npm publication.

See [Releasing DRS](RELEASING.md) for environment protection, npm trusted-publisher, Pages, and recovery requirements.

## Verification Checklist

Run these checks after updating configuration and workflows:

```bash
drs doctor --json
drs workflow validate
drs workflow list
```

Then run representative workflows in a non-production project. For posting workflows, first generate and inspect an artifact with `post=false`; only enable posting after the artifact and expected head SHA are correct.
