# DRS Desktop Dev Testing

Use this guide to run and smoke-test the Electron desktop app from a local DRS checkout.

## Prerequisites

- Node.js 22.19 or newer.
- A working DRS checkout with dependencies installed at the repository root.
- A DRS-compatible model/provider environment for workflows that call agents.
- GitHub/GitLab provider credentials when testing PR/MR workflows.
- Git available on `PATH`.

## First-Time Setup

From the repository root:

```bash
npm install
npm run build
```

Then install the desktop package dependencies:

```bash
cd desktop
npm install
```

The desktop app resolves the DRS CLI in this order:

1. `DRS_CLI=/absolute/path/to/drs`
2. `../dist/cli/index.js` from this checkout
3. `drs` on `PATH`
4. `npx tsx ../src/cli/index.ts` as a dev fallback

For normal local development, `npm run build` at the root is enough because the app uses `../dist/cli/index.js`.

## Run The App

Use production-style renderer build plus Electron:

```bash
cd desktop
npm start
```

Use hot reload while developing the renderer:

```bash
cd desktop
npm run dev
```

In another terminal:

```bash
cd desktop
npm run electron:dev
```

## Smoke Test Checklist

1. Launch the app.
2. Confirm the default repository is the DRS repo root, not `desktop/`.
3. Confirm the left project sidebar shows the current project under "Workspace" nav (Review /
   Workflows / Settings) and lists recent projects. Use it to switch mode instead of a top-bar
   toggle.
4. Open a second project via the sidebar's `Open Project...` entry, confirm it becomes the active
   project, then remove it from "Recent" via the hover "x" action.
5. Switch to Workflows mode and confirm the workflow browser lists packaged and project workflows.
6. Make a small local change in the repo.
7. Select the `local-review` workflow and confirm the workflow detail/input panel appears.
8. Click `Refresh` and confirm the diff appears.
9. Confirm the Pierre file tree groups changed files by directory, shows git status/count decorations, supports search, and click a file to scroll to it.
10. Toggle `Unified` / `Split` and confirm the diff layout changes.
11. Toggle `Unstaged` and `Staged` and confirm the diff source changes as expected.
12. Drag the resize handles between the file tree, diff, and issues/chat sidecar (and between the
    issues panel and chat panel) and confirm each pane resizes and the layout persists after
    reloading the app.
13. Click `Run Workflow` in Workflows mode or `Run Review` in Review mode and confirm live logs
    stream in the run banner.
14. Confirm the run appears in the workflow run history.
15. Confirm review issues appear in the issue panel and inline in the diff when a canonical review artifact is produced under `.drs/artifacts/`.
16. Click an issue and confirm the diff scrolls to the matching file/line.
17. Click `Copy MD` and paste elsewhere to confirm Markdown was copied.
18. If CRITICAL/HIGH issues exist, click `Fix >= High` and confirm the fix workflow runs and refreshes the diff.
19. Select a non-review workflow and confirm the main panel switches to JSON workflow output.
20. Start a long-running workflow and click `Cancel` to confirm cancellation updates the run banner.

## GitHub/GitLab Smoke Test

Use the workflow browser in Workflows mode:

1. Select `github-pr-review`, enter `owner`, `repo`, and `pr`, then click `Run Workflow`.
2. Confirm live logs stream and the source banner changes to the PR review source.
3. Confirm the remote PR diff appears in the diff viewer when the workflow returns `artifacts.change.filesWithDiffs`.
4. Confirm issues from the canonical review artifact appear in the issue panel and inline on matching diff lines.
5. Select `gitlab-mr-review`, enter `project` and `mr`, then click `Run Workflow`.
6. Repeat the same checks for the MR diff and issues.
7. Leave `describe`, `post`, `visual`, and `fix` unchecked unless you intentionally want side effects on the PR/MR.

## Quality Checks

Run desktop-specific checks:

```bash
cd desktop
npm run typecheck
npm run build
```

Run the root DRS quality gate after changing shared/core code:

```bash
npm run check:all
```

The current root quality gate does not include the desktop package. Run the desktop checks separately for desktop-only changes.

## Useful Environment Variables

- `DRS_CLI=/absolute/path/to/drs`: force the desktop app to use a specific CLI executable.
- `ELECTRON_RENDERER_URL=http://127.0.0.1:5173`: force Electron to load a Vite dev server.
- `DRS_DESKTOP_MAX_DIFF_BYTES=2097152`: maximum local patch size the desktop app will send
  to the renderer. Raise only when testing very large diffs.
- `NO_COLOR=1` and `FORCE_COLOR=0`: already set by the app when spawning DRS so logs stay parseable.

## Generated Files

These are intentionally ignored and should not be committed:

- `desktop/node_modules/`
- `desktop/dist-renderer/`
- `desktop/out/`
- `.drs/.desktop-run.json`
- `.drs/artifacts/`

`desktop/package-lock.json` is commit-worthy and should stay tracked with `desktop/package.json`.

## Troubleshooting

If workflows do not list, verify the CLI works from the selected repository:

```bash
node dist/cli/index.js workflow list --json
```

If Electron opens a Vite error page, either start the dev server with `npm run dev` or run `npm start` to build `dist-renderer/` before launching.

If the app cannot find DRS in a packaged build, set `DRS_CLI` to an installed `drs` executable.

If review issues do not appear inline, confirm the issue `file` and `line` values in the latest review artifact match the new-file paths and line numbers in `git diff`.
