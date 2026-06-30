# DRS Desktop — Implementation Notes

A native Electron desktop UI for [DRS (Diff Review System)](..). This document
records what was built in the Path B MVP, how it is structured, how it was
validated, and what comes next.

> **TL;DR** — A new `desktop/` package that renders split/unified diffs with
> `@pierre/diffs`, shows a changed-file tree with `@pierre/trees`, overlays DRS review issues inline
> on diff lines, runs any DRS workflow (including the fix-and-verify loop), and
> streams live logs — all by driving the existing DRS CLI as a child process. The
> CLI engine is unchanged.

---

## 1. Background & approach

DRS is a workflow-first AI code maintenance CLI (Node + TypeScript + Pi SDK).
[Codiff](https://github.com/nkzw-tech/codiff) is an Electron diff viewer that
already integrates with the same Pi SDK and supports inline review comments.

Two paths were considered:

- **Path A** — Fork/adapt Codiff. Rejected: large, fast-moving, opinionated
  upstream (vite-plus, SWC, React Compiler, pnpm catalog) → merge debt.
- **Path B** *(chosen)* — Stand up a focused DRS Electron app that reuses
  Codiff's *patterns* and reuses DRS's existing library code, without forking.

Path B keeps the DRS CLI 100% intact and adds the desktop app as a new surface
over the same engine. DRS adds the automated fix-and-verify loop that Codiff
lacks, making the combination more powerful than either alone.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  React renderer  (src/renderer/, bundled by Vite)            │
│  • FileTree   • DiffView   • IssuesPanel   • Sidebar          │
│  • @pierre/diffs   • @pierre/trees   • markdown formatter      │
└────────────────────────┬────────────────────────────────────┘
                         │  window.drs.*  (contextBridge IPC)
┌────────────────────────┴────────────────────────────────────┐
│  Electron main process  (electron/*.cjs, CommonJS)           │
│  main.cjs   preload.cjs   drs-cli.cjs   git.cjs              │
└────────────────────────┬────────────────────────────────────┘
                         │  child process (spawn)
┌────────────────────────┴────────────────────────────────────┐
│  DRS CLI  (dist/cli/index.js, ESM)                           │
│  drs workflow run --output .drs/.desktop-run.json …          │
│  drs workflow list --json   /   drs workflow show <name> -j  │
│        → writes review JSON to .drs/review-output.json        │
└─────────────────────────────────────────────────────────────┘
```

### Why child-process instead of in-process import?

The Electron main process is CommonJS (Electron's convention); DRS compiles to
ESM (`"type": "module"`). Importing ESM from CJS at runtime is fragile
(`await import()` in CJS, top-level await constraints, etc.). Instead the app
drives the DRS CLI as a child process and reads structured JSON from disk:

- `drs workflow run --output <file>` writes clean `JSON.stringify(result)` to a
  file (via DRS's `writeWorkflowFile`), avoiding stdout-mixed-with-logs parsing.
- `drs workflow list --json` / `drs workflow show <name> --json` emit pure JSON
  to stdout.
- `.drs/review-output.json` holds the `ReviewJsonOutput` (issues + summary).

### DRS ↔ desktop data mapping

DRS's `ReviewIssue` maps cleanly onto an inline diff comment:

| DRS `ReviewIssue`        | Desktop rendering                          |
|--------------------------|--------------------------------------------|
| `issue.file`             | diff file path (prefix-stripped to match)  |
| `issue.line`             | new-file line number → diff line           |
| `issue.problem` + `solution` | inline comment body                    |
| `issue.severity`         | severity badge (🔴🟡🟠⚪) + CSS class       |
| `issue.category`         | category badge (🔒📊✨⚡📝)                  |
| `issue.agent`            | metadata line in issue card                |

---

## 3. File inventory

26 source files (excluding `node_modules` and build output):

```
desktop/
├── package.json              # app manifest + scripts
├── package-lock.json         # (generated)
├── tsconfig.json             # renderer TS config (DOM lib, JSX react-jsx)
├── tsconfig.node.json        # vite.config.ts TS config
├── vite.config.ts            # Vite build (base './', alias @ → src)
├── forge.config.cjs          # Electron Forge packaging (zip makers)
├── index.html                # Vite HTML entry → /src/renderer/main.tsx
├── .gitignore
├── README.md                 # user-facing setup/run guide
├── IMPLEMENTATION.md         # ← this file
│
├── electron/                 # Electron main process (CommonJS)
│   ├── main.cjs              # BrowserWindow + all IPC handlers
│   ├── preload.cjs           # contextBridge → window.drs API
│   ├── drs-cli.cjs           # DRS CLI resolver + spawner
│   └── git.cjs               # git diff helpers (patch, name-status, stat)
│
└── src/
    ├── shared/
    │   └── ipc-types.ts      # IPC contract (mirrors DRS library types)
    └── renderer/             # React 18 app
        ├── main.tsx          # createRoot entry
        ├── App.tsx           # state management + layout
        ├── types.ts          # re-exports + Window.drs global augmentation
        ├── styles.css        # dark theme (Catppuccin-inspired)
        ├── lib/
        │   ├── diff.ts       # unified-diff parser + issue-line index
        │   ├── badges.ts     # severity/category emoji, ranks, helpers
        │   └── markdown.ts   # review → Markdown exporter + clipboard
        └── components/
            ├── Toolbar.tsx       # staged toggle, run/fix/copy buttons
            ├── Sidebar.tsx       # repo picker + workflow list + input forms
            ├── DiffView.tsx      # diff rendering + inline issue overlay
            ├── IssuesPanel.tsx   # filterable issue list + severity chips
                        └── RunBanner.tsx     # live log stream + cancel/dismiss
```

---

## 4. Component-by-component detail

### `electron/main.cjs` — main process
- Creates a 1440×920 `BrowserWindow` with `contextIsolation: true`,
  `nodeIntegration: false`, and the preload script.
- Loads the Vite dev server (`http://127.0.0.1:5173`) if available, else the
  built `dist-renderer/index.html`.
- IPC handlers:
  - `drs:selectDirectory` → native folder picker
  - `drs:getCwd` → process.cwd() (for dev repo-root detection)
  - `drs:listWorkflows` → `drs workflow list --json`
  - `drs:showWorkflow` → `drs workflow show <name> --json`
  - `drs:getDiff` → `git -C <dir> diff [--cached] --no-color`
  - `drs:getReviewArtifact` → reads `.drs/review-output.json`
  - `drs:runWorkflow` → `drs workflow run <name> --output .drs/.desktop-run.json
    --input k=v …`, streams logs via `event.sender.send('drs:workflowLog')`
  - `drs:cancelWorkflow` → `SIGTERM` the child process
  - `drs:readFile`, `drs:openExternal`

### `electron/preload.cjs` — contextBridge
Exposes a typed `window.drs` API with ~12 methods + an `onWorkflowLog`
subscription. Strict isolation: the renderer has no Node access.

### `electron/drs-cli.cjs` — CLI resolver
Resolution order:
1. `DRS_CLI` env var (absolute path to a `drs` executable)
2. Dev: `<repoRoot>/dist/cli/index.js` (run with this Node)
3. `drs` on `PATH`
4. Dev fallback: `npx tsx <repoRoot>/src/cli/index.ts`

Spawns with `FORCE_COLOR=0 NO_COLOR=1` so output is parseable. Streams
stdout/stderr to the `onOutput` callback for live logs.

### `electron/git.cjs` — git helpers
Runs `git -C <dir> diff [--cached]` for patch, `--name-status`, and `--stat`.
Returns `{ patch, nameStatus, stat }`.

### `src/shared/ipc-types.ts` — IPC contract
TypeScript interfaces mirroring DRS library types (`ReviewIssue`, `ReviewSummary`,
`ReviewJsonOutput`, `WorkflowListEntry`, `WorkflowDetail`, `WorkflowRunResultJson`,
`DrsApi`). The main process references these via JSDoc typedefs; the renderer
imports them as types. This avoids a hard build-time dependency on the DRS
package while keeping the contract in sync.

### `src/renderer/lib/diff.ts` — diff parser
A from-scratch unified-diff parser (`parseUnifiedDiff`) that handles:
- New files (`+++ b/…`, `--- /dev/null`), deletions, renames, binary files
- Path prefix stripping (`a/`/`b/` → repo-relative, matching DRS issue `file`)
- Hunk headers (`@@ -old,count +new,count @@`) with accurate old/new line
  number tracking per line
- Add/delete/context line classification with running line counters

### `src/renderer/lib/markdown.ts` — review exporter
`buildReviewMarkdown(review)` produces a self-contained Markdown document with
summary stats, severity/category breakdowns, and per-issue sections (title,
file:line, problem, solution, references). Mirrors DRS's `formatSummaryComment`
spirit without importing the Node-based formatter (the renderer runs in a
browser). Includes a clipboard-copy fallback.

### `src/renderer/App.tsx` — state + orchestration
Central state: `workingDir`, `workflows`, `staged`, `diffPatch`, `review`,
`runState`, `severityFilter`, `selectedIssueKey`, `scrollTarget`.

Boot sequence: reads `getCwd()`, infers the DRS repo root (parent of `desktop/`
in dev), then loads workflows + diff + review artifact in parallel.

`startWorkflow(name, inputs)` is the core runner: sets a run banner, calls
`window.drs.runWorkflow`, loads the returned `reviewOutput` into state, reloads
the diff (workflows may change the tree), and finalizes the banner. Errors are
captured into both the banner and a global error banner.

`handleFixIssues` computes `fixSeverity` from the review's severity counts
(CRITICAL if any, else HIGH) and runs `local-fix-review-issues`.

### `src/renderer/components/` — UI components
- **Toolbar** — staged/unstaged segment toggle, Refresh, Run Review (primary),
  Fix ≥ High (shows actionable count), Copy MD. Disables actions appropriately.
- **Sidebar** — repo card with Open button, run banner, workflow list. Each
  workflow row expands to show a dynamic input form (boolean → checkbox, enum →
  select, number/string → text input) with defaults populated from
  `drs workflow show --json`.
- **DiffView** — renders parsed `DiffFile[]` as sticky-header cards with hunk
  meta, line gutters, and `+`/`−` prefixed content. Overlays `ReviewIssue`s as
  inline `.line-issue` blocks directly below their target line. Scrolls to the
  selected line via DOM id lookup.
- **IssuesPanel** — severity filter chips (toggleable), issue cards with
  severity badge, title, file:line, problem preview, agent. Clicking selects +
  triggers diff scroll.
- **RunBanner** — spinner/status dot, workflow name, live log stream (last
  4KB), error display, Cancel (while running) / Dismiss (when done).

---

## 5. Features delivered

| Feature | Status |
|---|---|
| Diff viewer (split/unified, working-tree + staged) | ✅ |
| Changed-file tree navigation (`@pierre/trees`) | ✅ |
| File status badges (A/D/M/R) + add/del counts | ✅ |
| Inline DRS review issues on diff lines | ✅ |
| Issue panel with severity filter + click-to-scroll | ✅ |
| Run any packaged/project workflow | ✅ |
| Dynamic workflow input forms | ✅ |
| One-click Run Review (`local-review`) | ✅ |
| One-click Fix ≥ High (`local-fix-review-issues` with verify loop) | ✅ |
| Live workflow log streaming | ✅ |
| Cancel in-flight workflows | ✅ |
| Copy review as Markdown | ✅ |
| Repository picker (native dialog) | ✅ |
| Error banners (global + diff) | ✅ |
| Dark theme | ✅ |
| TypeScript strict type-check | ✅ zero errors |
| Vite production build | ✅ 161KB JS / 10KB CSS |
| Electron Forge packaging config | ✅ (zip makers) |

---

## 6. Validation results

All checks run and passing:

```
TYPE-CHECK: PASS          (tsc --noEmit, zero errors)
BUILD: PASS               (vite build, 39 modules, ✓ built)
Main-process modules load: OK   (node -e require)
DRS CLI resolver:         OK   (finds dist/cli/index.js)
workflow list --json:     OK   (returns expected shape)
Diff parser test:         OK   (parses files, hunks, line types, counts)
Issue line index test:    OK   (maps file:line → issues)
Markdown formatter test:  OK   (produces correct review export)
```

The diff parser was tested with a synthetic patch containing a modified file
with add/delete/context lines — correctly produced 1 file, 2 additions, 1
deletion, 1 hunk with 5 lines, each with accurate `oldLine`/`newLine`.

The markdown formatter was tested with a 3-issue review — correctly produced the
title, summary stats, severity breakdown, category breakdown, and per-issue
sections.

---

## 7. How to run

```bash
cd /home/manojlds/projects/drs/desktop
npm install              # one-time

# Option 1: build + launch
npm start                # builds renderer, launches Electron

# Option 2: hot-reload dev (two terminals)
npm run dev              # terminal 1: Vite dev server at 127.0.0.1:5173
npm run electron:dev     # terminal 2: Electron loads dev server
```

The DRS repo must be built (`npm --prefix ../ run build`) or `drs` installed
globally, or `DRS_CLI` set. The repo is already built in this workspace.

---

## 8. Key design decisions

1. **Child-process over in-process** — CJS main + ESM DRS = fragile interop.
   Spawning the CLI + reading JSON from disk is robust and matches Codiff's
   proven pattern.

2. **`--output <file>` over `--json` stdout parsing** — `--json` mixes JSON with
   human logs on stdout. `--output` writes clean JSON to a file via DRS's
   `writeWorkflowFile`, so the app reads a guaranteed-clean result.

3. **Use `@pierre/diffs` for rendering** — the app now uses Pierre's diff parser
   and React `FileDiff` renderer for split/unified layouts and syntax-highlighted
   rendering. The local diff helpers still keep a small fallback parser for
   metadata and issue indexing resilience.

4. **Use `@pierre/trees` for file navigation** — the changed-file navigator is a
   DRS adapter around Pierre's React file tree. DRS supplies paths, git status,
   and add/delete count decorations; Pierre handles tree projection, search,
   sticky folders, selection, and virtualization.

5. **Shared IPC types without a DRS package dependency** — `ipc-types.ts` mirrors
   DRS types by hand. This keeps the desktop build independent of the DRS
   package's internal export graph. The types are small and stable.

6. **Renderer is framework-light** — React 18 + plain CSS (no Tailwind, no UI
   kit). Keeps the dependency surface minimal and the bundle small.

---

## 9. What's next (post-MVP)

### High value
- **Post to PR/MR** — reuse DRS's `comment-poster.ts` + `@octokit/rest` /
  `@gitbeaker/node` to submit inline comments / approve / request changes
  directly from the desktop UI.
- **Per-issue "Ask agent"** — like Codiff's review-assist: send the issue's
  problem/solution + diff context to a Pi agent and show the reply inline.
- **Repository watcher** — auto-refresh the diff when files change on disk
  (Codiff has `repository-watcher.cjs` as a reference).

### Medium value
- **GitHub PR / GitLab MR diff sources** — load diffs from a PR/MR number
  instead of only the working tree (DRS's `github-pr-review` / `gitlab-mr-review`
  workflows already fetch these).
- **Review artifact history** — browse past `.drs/artifacts/…/latest.json`
  review artifacts and compare across runs.
- **Command bar** — VS Code-style `Cmd+Shift+P` command palette (Codiff has a
  full `command-registry.ts` as reference).
- **Configurable keymap + themes** — light/dark/system toggle.

### Polish
- **Image diff previews** (side-by-side image revisions).
- **Markdown preview rendering** inline (render added `.md` content live).
- **"Viewed" toggle** per file (track review progress).
- **Multiple windows** (one per repository).



