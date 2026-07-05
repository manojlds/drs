---
name: drs-factory-planning
description: Use when planning, creating, refining, or reviewing PRDs; clarifying product requirements; or working in DRS Factory PRD mode.
drsManaged: true
drsSkillVersion: 1
---

# DRS Factory Planning Skill

Use this skill when a user wants to plan product work, write or review a PRD, or clarify requirements before story conversion.

## Operating Contract

- Planning only: do not implement code, run scheduler work, create branches, commit, or claim implementation tasks unless the user explicitly exits planning mode.
- Artifact first: durable PRD changes must go through DRS Factory commands so DRS can version, inspect, and revert them.
- Approval gated: keep PRDs reviewable until the user explicitly approves them.
- Challenge vague inputs. Do not passively summarize unclear requirements into confident-looking PRDs.
- Separate `what/why` from `how`. Technical notes are allowed, but label them as constraints, options, or assumptions unless confirmed.
- Preserve user intent. When revising a PRD, explain material scope changes and keep unresolved decisions visible.

## Session Start

When a PRD chat starts from DRS Desktop/ACP, the first user message should be treated as the kickoff. Do not expect extra runtime instructions. First orient on the selected PRD and classify readiness:

- `ready`: enough context exists to critique or refine the PRD.
- `needs clarification`: important gaps exist; ask focused questions before drafting or updating.
- `too broad`: scope is too large or ambiguous; narrow it before writing stories.

If a PRD id is available, read it before proposing changes:

```bash
drs factory prd-show <prdId>
```

Then tell the user what is missing, risky, or ready to proceed.

For a newly created PRD, do not just summarize. Run the PRD Review Loop immediately: inspect the artifact, ask the most important clarifying questions, and persist a better skeleton only when it improves the user's current draft.

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

When improving a PRD:

- Summarize the current intent in one short paragraph.
- Identify gaps and risky assumptions before editing.
- Ask clarifying questions when uncertainty would materially change scope.
- If enough information exists, propose concrete edits and persist them with `drs factory prd-update`.
- After updating, explain the important changes and remaining open questions.

## Story Handoff Rules

Story conversion belongs to the Factory stories skill after PRD approval.

When asked to go from PRD to stories:

1. Confirm the PRD passes the Completeness Gate.
2. Request PRD review with `drs factory prd-review-request <prdId>` when the PRD is ready.
3. Ask for explicit PRD approval before running `drs factory prd-approve <prdId>`.
4. Tell the user the next step is: use the Factory stories skill to convert the approved PRD into structured stories.

Good stories:

- Have one user/system outcome.
- Include acceptance criteria.
- Name dependencies and sequencing constraints.
- Avoid bundling unrelated UI, API, persistence, and cleanup work unless required for one thin slice.

Avoid stories that are only:

- "Build backend"
- "Build frontend"
- "Refactor everything"
- "Add tests"
- "Integrate all APIs"

Use technical tasks only when they unblock or de-risk a user-facing story, and label them clearly.

## Approval And Import Gates

Do not move past PRD planning until:

- The PRD passes the Completeness Gate.
- The user explicitly requests review or approval.
- DRS Factory coordinator state has been updated through the PRD review/approval commands.

Useful commands:

```bash
drs factory workflow-status <prdId>
drs factory prd-review-request <prdId>
drs factory prd-approve <prdId>
drs factory prd-changes-request <prdId>
```

If the user asks to import before story approval, explain that story conversion/import is handled by the Factory stories skill after PRD approval.

## Handoff Package

Before ending a planning session, provide:

- Current PRD status.
- Key resolved decisions.
- Open questions or accepted risks.
- Recommended next action: clarify, update PRD, request PRD review, approve PRD, or hand off to the Factory stories skill.

## Anti-Patterns

- Do not write directly to `.drs/factory` files.
- Do not invent approvals.
- Do not generate a large backlog from an unclear PRD.
- Do not hide unresolved questions inside acceptance criteria.
- Do not turn implementation suggestions into requirements without confirmation.
- Do not use recursive chat commands from inside an already-running agent session.

## Artifact Commands

Use DRS Factory commands for durable state:

```bash
drs factory list
drs factory prd-create --title "..." --description "..."
drs factory prd-show <prdId>
drs factory prd-update <prdId> --markdown "..."
drs factory prd-status <prdId> draft|in_review|approved|active|paused|done|archived
drs factory workflow-status <prdId>
drs factory prd-review-request <prdId>
drs factory prd-approve <prdId>
drs factory prd-changes-request <prdId>
drs factory prd-history <prdId>
drs factory prd-revert <prdId> <versionId>
```

Prefer these commands over editing Factory files directly so DRS can maintain versions, approvals, and task import state.
