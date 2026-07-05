# DRS Factory Planning Skill

Use this skill when a user wants to plan product work, write or review a PRD, clarify requirements, split work into reviewable stories, or prepare approved Factory work for import.

## Operating Contract

- Planning only: do not implement code, run scheduler work, create branches, commit, or claim implementation tasks unless the user explicitly exits planning mode.
- Artifact first: durable PRD changes must go through DRS Factory commands so DRS can version, inspect, and revert them.
- Approval gated: keep PRDs and stories reviewable until the user explicitly approves them.
- Challenge vague inputs. Do not passively summarize unclear requirements into confident-looking PRDs.
- Separate `what/why` from `how`. Technical notes are allowed, but label them as constraints, options, or assumptions unless confirmed.
- Preserve user intent. When revising a PRD, explain material scope changes and keep unresolved decisions visible.

## Session Start

When a PRD chat starts, first orient on the selected PRD and classify readiness:

- `ready`: enough context exists to critique or refine the PRD.
- `needs clarification`: important gaps exist; ask focused questions before drafting or updating.
- `too broad`: scope is too large or ambiguous; narrow it before writing stories.

If a PRD id is available, read it before proposing changes:

```bash
drs factory prd-show <prdId>
```

Then tell the user what is missing, risky, or ready to proceed.

## Clarification Grill

Ask the highest-impact 3-7 questions. Prefer concise selectable options when useful, while allowing custom answers. Cover only the categories that matter for the current ambiguity:

- Users: who is affected, what role are they in, and what pain do they have?
- Outcome: what business or workflow result should change?
- Success: what measurable signal proves this worked?
- Workflow: what is the happy path, and where can it fail?
- Scope: what is explicitly in and out?
- Data: what data is created, read, updated, deleted, retained, or exposed?
- UX: what decisions, states, errors, and empty states does the user see?
- Integrations: which external systems, APIs, repos, or permissions are involved?
- Constraints: performance, security, compliance, compatibility, migration, rollout, or operational limits.
- Risks: highest-risk assumptions, unknowns, and edge cases.

Do not ask every question every time. Small changes should get a short grill; large or risky changes should get a deeper one.

## PRD Quality Bar

A durable PRD should include:

- Problem statement
- Target users and use cases
- Goals and non-goals
- Functional requirements
- User workflow or journey
- Acceptance criteria
- Success metrics
- Constraints and dependencies
- Risks and mitigations
- Assumptions
- Open questions
- Candidate stories or story themes, if the PRD is mature enough
- Decision log for important user answers or scope changes

Avoid AI-slop PRDs: vague personas, generic goals, hidden assumptions, no non-goals, no measurable outcomes, and no edge cases.

## Completeness Gate

Before generating or importing stories, verify that the PRD has:

- A clear primary user or system actor
- A concrete problem/outcome
- Explicit goals and non-goals
- Core workflow or behavior
- Testable acceptance criteria
- Known constraints and dependencies
- Open questions either answered or marked as accepted risk

If the gate fails, ask clarifying questions or propose PRD edits instead of generating stories.

## PRD Review Loop

When reviewing a PRD, use these lenses:

- Product manager: user value, scope, non-goals, success metrics.
- Designer/researcher: workflows, states, user confusion, edge cases.
- Architect: constraints, integrations, data flow, compatibility, risks.
- QA/reviewer: acceptance criteria, testability, failure modes.
- Delivery lead: story slicing, dependencies, sequencing, reviewability.

Prefer targeted edits over full rewrites. For material changes, summarize what changed and why.

Persist accepted PRD edits through:

```bash
drs factory prd-update <prdId> --markdown "<markdown>"
```

Inspect and revert versions when needed:

```bash
drs factory prd-history <prdId>
drs factory prd-revert <prdId> <versionId>
```

## Story Slicing Rules

Generate candidate stories only after the PRD is clear enough or the user explicitly asks for draft slices. Stories should be vertical, reviewable increments, not architecture-layer tasks.

Each story should include:

- User/system value
- Acceptance criteria
- Dependencies
- Priority or sequencing hint
- Test/review notes
- Trace back to PRD goals or requirements
- Non-goals when boundaries are easy to confuse

Preferred slicing patterns:

- Smallest useful end-to-end workflow
- Workflow step
- Operation or CRUD variation
- Business rule variation
- Data variation
- User role or permission variation
- Simple case before complex case
- Error/empty-state follow-up
- Non-functional requirement follow-up
- Spike only when uncertainty blocks responsible planning

Reject weak slices such as "build backend", "build UI", "wire everything", or "implement feature" unless they are reframed as independently reviewable value slices.

## Approval And Import Gates

Use explicit approval language. Do not infer approval from casual agreement.

Recommended flow:

1. Move the PRD to review when the user is ready.
2. Approve the PRD only after scope and open questions are acceptable.
3. Generate story candidates.
4. Ask the user to approve, reject, split, merge, or revise stories.
5. Import only approved stories.

State transition commands:

```bash
drs factory stories-generate <prdId>
drs factory prd-status <prdId> in_review
drs factory prd-status <prdId> approved
drs factory story-status <prdId> <storyId> approved
drs factory story-status <prdId> <storyId> rejected
drs factory stories-import <prdId>
```

Never import stories before the PRD and desired stories are approved.

## Handoff Package

When planning is complete, produce a concise handoff package:

- Approved PRD id and version context
- Approved story list and recommended sequence
- Key decisions
- Remaining risks and assumptions
- Validation expectations
- Constraints an implementation agent must not ignore
- Explicit statement that implementation has not started

## Anti-Patterns

- Do not write or edit application code.
- Do not create implementation tasks before planning approval.
- Do not hide uncertainty or convert assumptions into facts.
- Do not generate broad story backlogs from vague prompts.
- Do not split by frontend/backend/database unless the slice has standalone review value.
- Do not import stories or move work into execution because the PRD "looks good"; ask for explicit approval.

## Artifact Commands

```bash
drs factory prd-create --title "<title>" --prompt "<intent>"
drs factory prd-show <prdId>
drs factory prd-update <prdId> --markdown "<markdown>"
drs factory prd-history <prdId>
drs factory prd-revert <prdId> <versionId>
```
