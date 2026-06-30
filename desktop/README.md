# DRS Desktop

An Electron UI for [DRS (Diff Review System)](..): view diffs, see DRS review
issues inline, run any DRS workflow, and trigger the fix-and-verify loop — all
from a desktop app.

> **Status:** MVP (Path B). The desktop app is a new surface over the existing
> DRS CLI engine. The CLI stays fully intact; the app drives it as a child
> process and reads structured JSON from disk.

## What it does

- **Diff viewer** — renders the working-tree (unstaged or staged) diff with
  `@pierre/diffs`, split/unified layout toggle, add/delete/modify/rename badges,
  and `+`/`−` counts per file.
- **File tree** — uses `@pierre/trees` to show changed files grouped by
  directory with git status and add/delete count decorations; selecting a file
  scrolls the diff to that file.
- **Inline DRS reviews** — overlays `ReviewIssue`s from `.drs/review-output.json`
  directly on the diff lines they reference, with severity/category badges.
- **Issue panel** — filterable, clickable list of all review findings; clicking
  an issue scrolls the diff to the exact line.
- **Run any workflow** — the sidebar lists all packaged + project workflows
  (via `drs workflow list`), shows their inputs with forms, and runs them.
- **Run Review** — one-click `local-review` (DRS agents review the current diff).
- **Fix ≥ High** — one-click `local-fix-review-issues` for CRITICAL/HIGH
  findings, with the DRS fix → re-review → verify loop. Live logs stream in.
- **Copy as Markdown** — export the review as Markdown for pasting anywhere.

## Prerequisites

- Node.js 22.19+
- A working DRS setup in the target repo (`.drs/drs.config.yaml`, model provider
  env vars). See the [DRS README](../README.md).

## Setup

From the `desktop/` directory:

```bash
npm install
```

Then ensure the DRS CLI is resolvable (one of):

1. **Build the DRS repo** (dev): `npm --prefix ../ run build` — the app uses
   `../dist/cli/index.js`.
2. **Install DRS globally**: `npm install -g @diff-review-system/drs` — the app
   finds `drs` on `PATH`.
3. **Point at a custom CLI**: set `DRS_CLI=/absolute/path/to/drs`.

## Run

```bash
# Build the renderer and launch Electron (uses built dist-renderer/)
npm start

# Hot-reload dev: Vite dev server + Electron
npm run dev          # in one terminal — starts Vite at 127.0.0.1:5173
npm run electron:dev # in another — Electron loads the dev server
```

For a full local smoke-test checklist and troubleshooting steps, see
[`DEV_TESTING.md`](./DEV_TESTING.md).

## How it works

```
React renderer (src/renderer/)
  ↕ window.drs.*  (contextBridge IPC, preload.cjs)
Electron main process (electron/main.cjs, CommonJS)
  ↕ child process
DRS CLI (drs workflow run --output .drs/.desktop-run.json ...)
  → writes review JSON to .drs/review-output.json
  → main process reads it and returns to renderer
```

The main process is CommonJS (Electron's convention); DRS compiles to ESM. The
app bridges that by driving the DRS CLI as a child process and reading
structured JSON (`--output` for run results, `.drs/review-output.json` for
review artifacts) — the same pattern Codiff uses for its agent backends.

## Package

```bash
npm run make    # electron-forge make → out/ (zip)
```

## Project layout

```
desktop/
  electron/        # Electron main process (CJS)
    main.cjs       # window + IPC handlers
    preload.cjs    # contextBridge → window.drs API
    drs-cli.cjs    # DRS CLI resolver + spawner
    git.cjs        # git diff helpers
  src/
    shared/        # IPC types shared by main + renderer
    renderer/      # React app
      App.tsx      # state + layout
      components/  # Sidebar, Toolbar, DiffView, IssuesPanel, RunBanner
      lib/         # diff parser, badges, markdown formatter
      styles.css   # dark theme
  index.html
  vite.config.ts
  forge.config.cjs
```

## License

Apache-2.0
