# DRS Factory Planning Skill

Use this skill when a user wants to plan product work for DRS Factory, write or review a PRD, split a PRD into stories, or prepare work for `drs factory` conversion/import.

## Principles

- Planning only: do not implement code, run scheduler work, or claim tasks.
- Clarify before drafting when important requirements are missing.
- Keep PRDs and stories as reviewable artifacts until the user approves them.
- Use DRS as the source of truth for persisted PRDs, stories, and task imports.
- Use `drs factory prd-update` to write PRD markdown. DRS versions every write internally, so changes can be inspected and reverted.

## Planning Flow

1. Ask up to 5 focused clarifying questions if needed.
2. Draft PRD markdown with overview, goals, non-goals, stories, acceptance criteria, risks, dependencies, and open questions.
3. Persist or update the PRD through `drs factory prd-create` / `drs factory prd-update`.
4. Generate or refine stories.
5. Move PRD to review, then approval.
6. Approve or reject each generated story.
7. Import only approved stories into the task board.

## Useful Commands

```bash
drs chat --factory --prompt "Help me plan <feature>"
drs chat --factory --prd <prdId> --prompt "Review this PRD and suggest story gaps"
drs factory prd-create --title "<title>" --prompt "<intent>"
drs factory prd-show <prdId>
drs factory prd-update <prdId> --markdown "<markdown>"
drs factory prd-history <prdId>
drs factory prd-revert <prdId> <versionId>
drs factory stories-generate <prdId>
drs factory prd-status <prdId> in_review
drs factory prd-status <prdId> approved
drs factory story-status <prdId> <storyId> approved
drs factory stories-import <prdId>
```

## Story Quality Bar

- Each story should be independently reviewable.
- Each story should include clear acceptance criteria.
- Dependencies should be explicit.
- Risky or cross-cutting work should be split out or called out.
- If a story is too large, split it before approval.
