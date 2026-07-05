---
name: drs-factory-stories
description: Use when converting an approved DRS Factory PRD into structured implementation stories and importing approved stories into the task backlog.
drsManaged: true
drsSkillVersion: 1
---

# DRS Factory Stories Skill

Use this skill when converting an approved Factory PRD into implementation-ready stories.

## Operating Contract

- Do not draft stories until the PRD is approved in DRS Factory.
- Treat DRS Factory coordinator state as source of truth.
- Draft stories in chat first and ask for explicit confirmation before writing story artifacts.
- Save structured stories with `drs factory stories-draft`, not by editing `.drs/factory` JSON directly.
- Request story review with `drs factory stories-review-request` after saving the draft.
- Do not import stories until the user approves them and DRS marks them approved.
- Do not implement stories unless the user explicitly exits planning mode.

## Required Flow

1. Inspect the current state:

```bash
drs factory prd-show <prdId> --json
drs factory workflow-status <prdId> --json
```

2. If the PRD is not approved, stop and ask the user to finish PRD approval first.

3. Convert the PRD into stories that are independently reviewable and implementation-sized.

4. Present the proposed story list in chat before mutating artifacts.

5. After explicit confirmation, write a JSON array of stories to a temporary file and run:

```bash
drs factory stories-draft <prdId> --file <path-to-json> --source agent
drs factory stories-review-request <prdId>
```

6. After the user approves the story set, run:

```bash
drs factory stories-approve <prdId>
drs factory stories-import <prdId>
```

## Story JSON Shape

Each story must use this shape:

```json
{
  "id": "US-001",
  "title": "Short user-visible outcome",
  "description": "As a ..., I want ..., so that ...",
  "acceptanceCriteria": ["Specific observable behavior"],
  "priority": 1,
  "status": "draft",
  "reviewStatus": "draft",
  "dependsOn": [],
  "notes": "Implementation constraints, risks, or test guidance"
}
```

## Story Quality Bar

- Each story should deliver a coherent vertical slice where possible.
- Acceptance criteria must be testable and observable.
- Dependencies should reference other story IDs only when sequencing is necessary.
- Avoid vague stories such as "build backend" or "update UI" unless the PRD truly requires that as an isolated technical slice.
- Include migration, rollout, validation, or documentation work only when needed for the feature to be safely shipped.

## Anti-Patterns

- Do not rely on Markdown headings as the primary conversion method.
- Do not import draft stories.
- Do not mark stories approved without explicit user approval.
- Do not bypass `drs factory` commands by editing generated JSON directly.
