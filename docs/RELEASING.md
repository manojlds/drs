# Releasing DRS

DRS releases use one manual transaction that commits release metadata, creates the tag, and dispatches tag-bound npm publication. Do not create release tags manually.

## Prerequisites

- The release automation changes must already be on the default branch.
- `DRS_PROVIDER_API_KEY` or the legacy `OPENCODE_API_KEY` must be configured for changelog and wiki maintenance.
- Create a protected GitHub environment named `release` with required reviewers, prevent self-review, and disable administrator bypass where policy allows.
- npm trusted publishing must authorize `.github/workflows/publish.yml` with the `release` environment. This environment setting is part of npm's trusted-publisher identity and must match exactly.
- The workflow token must be allowed `contents: write` and `actions: write` for the deterministic commit job.
- Allow `v*` tags in the existing `github-pages` environment deployment policy so tag-bound wiki publication can run.
- Do not queue multiple release or publication runs. GitHub concurrency retains at most one pending run and replaces older pending runs.

## Create A Release

Run the `Create release` workflow from the default branch with:

- `version`: exact SemVer without `v`, such as `5.0.0-rc.1` or `5.0.0`.
- `from`: the previous stable release tag. Use `v4.1.0` for cumulative 5.0 prerelease and final notes.
- `releaseDate`: optional `YYYY-MM-DD`; defaults to the current UTC date.

The workflow:

1. Pins the selected dispatch commit and rejects non-canonical or non-increasing SemVer, invalid dates, existing tags/npm versions, npm registry failures, stale default-branch checkouts, and any base other than the latest reachable stable tag.
2. Updates `package.json` and both lockfile version fields together.
3. Finalizes `CHANGELOG.md`, consolidating earlier prerelease sections for the same version line.
4. Refreshes and validates the canonical repository wiki and state.
5. Runs formatting, type, lint, build, test, wiki-site, package, and diff checks.
6. Rejects changes outside the package manifests, changelog, wiki, and wiki state.
7. Uploads a one-run binary patch from the read-only preparation job; a separate deterministic write job checks and applies only that patch.
8. Commits the release tree and atomically pushes the default branch plus a lightweight `v<version>` tag.
9. Explicitly dispatches CI, Pages, and `publish.yml` against that exact tag and commit because `GITHUB_TOKEN` pushes do not trigger ordinary push workflows.

The atomic push prevents a version commit without its tag, or a tag that omits the version/changelog/wiki commit.

## npm Publication

`publish.yml` is manual-only. It never rewrites package metadata and refuses to run unless:

- The workflow dispatch ref is the requested exact SemVer tag.
- The event, checkout, tag, and requested full commit SHA agree.
- The commit is reachable from the default branch.
- `package.json`, `package-lock.json`, the tag, and the changelog agree on the version.
- The npm version does not already exist.

Prereleases publish with npm dist-tag `next`; stable versions publish with `latest`. Publication is globally serialized and refuses to move either dist-tag to an equal or older SemVer.

## Recovery

If the atomic branch/tag push fails, fix the cause and rerun `Create release`. No release tag should exist.

If the tag exists but publication dispatch or npm publication fails, never move or recreate the tag. Re-dispatch `publish.yml` using the existing immutable values:

```bash
gh workflow run publish.yml \
  --ref v5.0.0-rc.1 \
  --field tag=v5.0.0-rc.1 \
  --field commit=<full-tag-commit-sha>
```

The publisher is idempotent only until npm accepts the version. It deliberately fails when that exact version already exists.

## 5.0 Sequence

Use `from=v4.1.0` for each cumulative release:

1. `5.0.0-rc.1` publishes to `next`.
2. Any later `5.0.0-*` prerelease replaces earlier 5.0 prerelease changelog sections and publishes to `next`.
3. `5.0.0` consolidates prerelease notes and publishes to `latest`.
