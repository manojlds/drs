# DRS Desktop Dev Testing

Use this guide to run and smoke-test the Electron desktop app from a local DRS checkout.

## Prerequisites

- Node.js 22.19 or newer.
- A working DRS checkout with dependencies installed at the repository root.
- A DRS-compatible model/provider environment for workflows that call agents.
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
3. Confirm the sidebar lists packaged and project workflows.
4. Make a small local change in the repo.
5. Click `Refresh` and confirm the diff appears.
6. Toggle `Unstaged` and `Staged` and confirm the diff source changes as expected.
7. Click `Run Review` and confirm live logs stream in the run banner.
8. Confirm review issues appear in the issue panel and inline in the diff when `.drs/review-output.json` is produced.
9. Click an issue and confirm the diff scrolls to the matching file/line.
10. Click `Copy MD` and paste elsewhere to confirm Markdown was copied.
11. If CRITICAL/HIGH issues exist, click `Fix >= High` and confirm the fix workflow runs and refreshes the diff.
12. Start a long-running workflow and click `Cancel` to confirm cancellation updates the run banner.

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
- `NO_COLOR=1` and `FORCE_COLOR=0`: already set by the app when spawning DRS so logs stay parseable.

## Generated Files

These are intentionally ignored and should not be committed:

- `desktop/node_modules/`
- `desktop/dist-renderer/`
- `desktop/out/`
- `.drs/.desktop-run.json`
- `.drs/review-output.json`
- `.drs/artifacts/`

`desktop/package-lock.json` is commit-worthy and should stay tracked with `desktop/package.json`.

## Troubleshooting

If workflows do not list, verify the CLI works from the selected repository:

```bash
node dist/cli/index.js workflow list --json
```

If Electron opens a Vite error page, either start the dev server with `npm run dev` or run `npm start` to build `dist-renderer/` before launching.

If the app cannot find DRS in a packaged build, set `DRS_CLI` to an installed `drs` executable.

If review issues do not appear inline, confirm the issue `file` and `line` values in `.drs/review-output.json` match the new-file paths and line numbers in `git diff`.
