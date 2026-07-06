import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { addTask, listTasks, type DrsTask } from './task-store.js';

export const FACTORY_DIR = '.drs/factory';
export const PRD_INDEX_RELATIVE_PATH = `${FACTORY_DIR}/prds/index.json`;

export const PRD_STATUSES = [
  'draft',
  'in_review',
  'approved',
  'active',
  'paused',
  'done',
  'archived',
] as const;
export type PrdStatus = (typeof PRD_STATUSES)[number];
export const STORY_REVIEW_STATUSES = ['draft', 'approved', 'rejected'] as const;
export type StoryReviewStatus = (typeof STORY_REVIEW_STATUSES)[number];
export const FACTORY_WORKFLOW_STAGES = [
  'prd_draft',
  'prd_review_requested',
  'prd_approved',
  'stories_draft',
  'stories_review_requested',
  'stories_approved',
  'stories_imported',
] as const;
export type FactoryWorkflowStage = (typeof FACTORY_WORKFLOW_STAGES)[number];
export const STORY_SET_STATUSES = [
  'not_started',
  'draft',
  'review_requested',
  'approved',
  'imported',
] as const;
export type FactoryStorySetStatus = (typeof STORY_SET_STATUSES)[number];
export type FactoryStorySetSource = 'agent' | 'manual';

export interface FactoryPrd {
  id: string;
  title: string;
  status: PrdStatus;
  description: string;
  prdPath: string;
  storiesPath: string;
  workflowStage: FactoryWorkflowStage;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  status: 'draft' | 'backlog' | 'todo';
  reviewStatus: StoryReviewStatus;
  dependsOn: string[];
  notes: string;
}

export interface PrdIndex {
  version: 1;
  prds: FactoryPrd[];
}

export interface FactoryStorySet {
  version: 1;
  prdId: string;
  status: FactoryStorySetStatus;
  source: FactoryStorySetSource;
  generatedAt?: string;
  approvedAt?: string;
  importedAt?: string;
  stories: FactoryStory[];
}

export interface FactoryWorkflowStatus {
  prdId: string;
  stage: FactoryWorkflowStage;
  prdStatus: PrdStatus;
  storySetStatus: FactoryStorySetStatus;
  allowedActions: string[];
  blockedReason: string | null;
}

export interface FactoryPrdVersion {
  id: string;
  prdId: string;
  markdown: string;
  createdAt: string;
  source: 'create' | 'update' | 'revert';
}

export async function listPrds(workingDir: string): Promise<FactoryPrd[]> {
  const index = await readPrdIndex(workingDir);
  return [...index.prds].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getPrd(
  workingDir: string,
  id: string
): Promise<{
  prd: FactoryPrd;
  markdown: string;
  stories: FactoryStory[];
  storySet: FactoryStorySet;
}> {
  const prd = await findPrd(workingDir, id);
  const markdown = await readOptionalFile(join(workingDir, prd.prdPath));
  const storySet = await readStorySetFile(workingDir, prd);
  return { prd, markdown, stories: storySet.stories, storySet };
}

export async function createPrd(
  workingDir: string,
  input: { title: string; description?: string; markdown?: string; status?: PrdStatus }
): Promise<{
  prd: FactoryPrd;
  markdown: string;
  stories: FactoryStory[];
  storySet: FactoryStorySet;
}> {
  const title = input.title.trim();
  if (!title) throw new Error('PRD title is required.');
  const index = await readPrdIndex(workingDir);
  const id = uniquePrdId(title, index.prds);
  const now = new Date().toISOString();
  const prdPath = `${FACTORY_DIR}/prds/${id}.md`;
  const storiesPath = `${FACTORY_DIR}/prds/${id}.stories.json`;
  const prd: FactoryPrd = {
    id,
    title,
    status: input.status ?? 'draft',
    description: input.description?.trim() ?? '',
    prdPath,
    storiesPath,
    workflowStage: 'prd_draft',
    createdAt: now,
    updatedAt: now,
  };
  const markdownInput = input.markdown?.trim();
  let markdown = defaultPrdMarkdown(title, prd.description);
  if (markdownInput && markdownInput.length > 0) markdown = markdownInput;
  await writeFileEnsured(join(workingDir, prdPath), `${markdown.trim()}\n`);
  await appendPrdVersion(workingDir, prd, markdown, 'create');
  const storySet = emptyStorySet(prd.id);
  await writeStorySetFile(workingDir, prd, storySet);
  await writePrdIndex(workingDir, { version: 1, prds: [...index.prds, prd] });
  return { prd, markdown, stories: [], storySet };
}

export async function updatePrdMarkdown(
  workingDir: string,
  id: string,
  markdown: string
): Promise<{
  prd: FactoryPrd;
  markdown: string;
  stories: FactoryStory[];
  storySet: FactoryStorySet;
}> {
  const index = await readPrdIndex(workingDir);
  const prdIndex = index.prds.findIndex((item) => item.id === id);
  if (prdIndex === -1) throw new Error(`PRD not found: ${id}`);
  const prd = { ...index.prds[prdIndex], updatedAt: new Date().toISOString() };
  const prds = [...index.prds];
  prds[prdIndex] = prd;
  await writeFileEnsured(join(workingDir, prd.prdPath), `${markdown.trim()}\n`);
  await appendPrdVersion(workingDir, prd, markdown, 'update');
  await writePrdIndex(workingDir, { version: 1, prds });
  return getPrd(workingDir, id);
}

export async function deletePrd(workingDir: string, id: string): Promise<FactoryPrd> {
  const index = await readPrdIndex(workingDir);
  const prd = index.prds.find((item) => item.id === id);
  if (!prd) throw new Error(`PRD not found: ${id}`);
  await Promise.all([
    rm(join(workingDir, prd.prdPath), { force: true }),
    rm(join(workingDir, prd.storiesPath), { force: true }),
    rm(prdVersionsPath(workingDir, prd), { recursive: true, force: true }),
  ]);
  await writePrdIndex(workingDir, {
    version: 1,
    prds: index.prds.filter((item) => item.id !== id),
  });
  return prd;
}

export async function listPrdVersions(
  workingDir: string,
  id: string
): Promise<FactoryPrdVersion[]> {
  const prd = await findPrd(workingDir, id);
  return (await readPrdVersions(workingDir, prd)).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

export async function revertPrdVersion(
  workingDir: string,
  id: string,
  versionId: string
): Promise<{
  prd: FactoryPrd;
  markdown: string;
  stories: FactoryStory[];
  storySet: FactoryStorySet;
}> {
  const prd = await findPrd(workingDir, id);
  const version = (await readPrdVersions(workingDir, prd)).find((item) => item.id === versionId);
  if (!version) throw new Error(`PRD version not found: ${versionId}`);
  await writeFileEnsured(join(workingDir, prd.prdPath), `${version.markdown.trim()}\n`);
  await appendPrdVersion(workingDir, prd, version.markdown, 'revert');
  return updatePrdStatusTimestampOnly(workingDir, id);
}

export async function updatePrdStatus(
  workingDir: string,
  id: string,
  status: PrdStatus
): Promise<{
  prd: FactoryPrd;
  markdown: string;
  stories: FactoryStory[];
  storySet: FactoryStorySet;
}> {
  if (!PRD_STATUSES.includes(status)) throw new Error(`Invalid PRD status: ${status}`);
  await updatePrdIndexEntry(workingDir, id, (prd) => ({ ...prd, status }));
  return getPrd(workingDir, id);
}

export async function requestPrdReview(workingDir: string, id: string) {
  await updatePrdIndexEntry(workingDir, id, (prd) => ({
    ...prd,
    status: 'in_review',
    workflowStage: 'prd_review_requested',
  }));
  return getPrd(workingDir, id);
}

export async function approvePrd(workingDir: string, id: string) {
  await updatePrdIndexEntry(workingDir, id, (prd) => ({
    ...prd,
    status: 'approved',
    workflowStage: 'prd_approved',
  }));
  return getPrd(workingDir, id);
}

export async function requestPrdChanges(workingDir: string, id: string) {
  await updatePrdIndexEntry(workingDir, id, (prd) => ({
    ...prd,
    status: 'draft',
    workflowStage: 'prd_draft',
  }));
  return getPrd(workingDir, id);
}

export async function draftStories(
  workingDir: string,
  id: string,
  stories: FactoryStory[],
  source: FactoryStorySetSource = 'agent'
): Promise<{
  prd: FactoryPrd;
  markdown: string;
  stories: FactoryStory[];
  storySet: FactoryStorySet;
}> {
  const current = await getPrd(workingDir, id);
  ensurePrdApprovedForStories(current.prd);
  const storySet = buildStorySet(current.prd.id, stories, source, 'draft');
  await writeStorySetFile(workingDir, current.prd, storySet);
  await updatePrdIndexEntry(workingDir, id, (prd) => ({ ...prd, workflowStage: 'stories_draft' }));
  return getPrd(workingDir, id);
}

export async function requestStoriesReview(workingDir: string, id: string) {
  const current = await getPrd(workingDir, id);
  if (current.storySet.stories.length === 0)
    throw new Error(`No draft stories found for PRD: ${id}`);
  await writeStorySetFile(workingDir, current.prd, {
    ...current.storySet,
    status: 'review_requested',
  });
  await updatePrdIndexEntry(workingDir, id, (prd) => ({
    ...prd,
    workflowStage: 'stories_review_requested',
  }));
  return getPrd(workingDir, id);
}

export async function approveStories(workingDir: string, id: string) {
  const current = await getPrd(workingDir, id);
  if (current.storySet.stories.length === 0) throw new Error(`No stories found for PRD: ${id}`);
  const now = new Date().toISOString();
  await writeStorySetFile(workingDir, current.prd, {
    ...current.storySet,
    status: 'approved',
    approvedAt: now,
    stories: current.storySet.stories.map((story) => ({
      ...story,
      reviewStatus: story.reviewStatus === 'rejected' ? 'rejected' : 'approved',
    })),
  });
  await updatePrdIndexEntry(workingDir, id, (prd) => ({
    ...prd,
    workflowStage: 'stories_approved',
  }));
  return getPrd(workingDir, id);
}

export async function updateStoryReviewStatus(
  workingDir: string,
  prdId: string,
  storyId: string,
  reviewStatus: StoryReviewStatus
): Promise<{
  prd: FactoryPrd;
  markdown: string;
  stories: FactoryStory[];
  storySet: FactoryStorySet;
}> {
  if (!STORY_REVIEW_STATUSES.includes(reviewStatus)) {
    throw new Error(`Invalid story review status: ${reviewStatus}`);
  }
  const current = await getPrd(workingDir, prdId);
  const stories = current.stories.map((story) =>
    story.id === storyId ? { ...story, reviewStatus } : story
  );
  if (!stories.some((story) => story.id === storyId))
    throw new Error(`Story not found: ${storyId}`);
  await writeStorySetFile(workingDir, current.prd, { ...current.storySet, stories });
  return getPrd(workingDir, prdId);
}

export async function importStoriesToTasks(workingDir: string, id: string): Promise<DrsTask[]> {
  const { prd, storySet, stories } = await getPrd(workingDir, id);
  if (prd.status !== 'approved' && prd.status !== 'active') {
    throw new Error(`PRD must be approved before importing stories: ${prd.id}`);
  }
  if (storySet.status !== 'approved' && storySet.status !== 'imported') {
    throw new Error(`Stories must be approved before importing: ${prd.id}`);
  }
  const existingTasks = await listTasks(workingDir);
  const existingByStory = new Set(
    existingTasks
      .filter((task) => task.prdId === prd.id && task.storyId)
      .map((task) => task.storyId as string)
  );
  const created: DrsTask[] = [];
  const storyToTask = new Map<string, string>();
  for (const task of existingTasks) {
    if (task.prdId === prd.id && task.storyId) storyToTask.set(task.storyId, task.id);
  }
  for (const story of stories.filter((item) => item.reviewStatus === 'approved')) {
    if (existingByStory.has(story.id)) continue;
    const task = await addTask(workingDir, {
      prdId: prd.id,
      storyId: story.id,
      title: story.title,
      description: story.description,
      status: story.status === 'draft' ? 'backlog' : story.status,
      priority: story.priority,
      acceptanceCriteria: story.acceptanceCriteria,
      dependsOn: story.dependsOn.map((storyId) => storyToTask.get(storyId)).filter(isString),
      source: { kind: 'manual', id: `${prd.id}:${story.id}` },
    });
    storyToTask.set(story.id, task.id);
    created.push(task);
  }
  await writeStorySetFile(workingDir, prd, {
    ...storySet,
    status: 'imported',
    importedAt: new Date().toISOString(),
  });
  await updatePrdIndexEntry(workingDir, id, (item) => ({
    ...item,
    status: 'active',
    workflowStage: 'stories_imported',
  }));
  return created;
}

export async function getFactoryWorkflowStatus(
  workingDir: string,
  id: string
): Promise<FactoryWorkflowStatus> {
  const { prd, storySet } = await getPrd(workingDir, id);
  const allowedActions = allowedFactoryActions(prd, storySet);
  return {
    prdId: prd.id,
    stage: prd.workflowStage,
    prdStatus: prd.status,
    storySetStatus: storySet.status,
    allowedActions,
    blockedReason: allowedActions.length > 0 ? null : blockedFactoryReason(prd, storySet),
  };
}

export function prdIndexPath(workingDir: string): string {
  return join(workingDir, PRD_INDEX_RELATIVE_PATH);
}

async function readPrdIndex(workingDir: string): Promise<PrdIndex> {
  try {
    const source = await readFile(prdIndexPath(workingDir), 'utf-8');
    const parsed = JSON.parse(source) as unknown;
    return normalizePrdIndex(parsed);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { version: 1, prds: [] };
    throw error;
  }
}

async function writePrdIndex(workingDir: string, index: PrdIndex): Promise<void> {
  validatePrdIndex(index);
  await writeFileEnsured(prdIndexPath(workingDir), `${JSON.stringify(index, null, 2)}\n`);
}

async function findPrd(workingDir: string, id: string): Promise<FactoryPrd> {
  const prd = (await listPrds(workingDir)).find((item) => item.id === id);
  if (!prd) throw new Error(`PRD not found: ${id}`);
  return prd;
}

async function updatePrdIndexEntry(
  workingDir: string,
  id: string,
  update: (prd: FactoryPrd) => FactoryPrd
): Promise<FactoryPrd> {
  const index = await readPrdIndex(workingDir);
  const prdIndex = index.prds.findIndex((item) => item.id === id);
  if (prdIndex === -1) throw new Error(`PRD not found: ${id}`);
  const prds = [...index.prds];
  const next = { ...update(prds[prdIndex]), updatedAt: new Date().toISOString() };
  prds[prdIndex] = next;
  await writePrdIndex(workingDir, { version: 1, prds });
  return next;
}

async function updatePrdStatusTimestampOnly(
  workingDir: string,
  id: string
): Promise<{
  prd: FactoryPrd;
  markdown: string;
  stories: FactoryStory[];
  storySet: FactoryStorySet;
}> {
  await updatePrdIndexEntry(workingDir, id, (prd) => prd);
  return getPrd(workingDir, id);
}

async function readPrdVersions(workingDir: string, prd: FactoryPrd): Promise<FactoryPrdVersion[]> {
  const source = await readOptionalFile(prdVersionsPath(workingDir, prd));
  if (!source.trim()) return [];
  const parsed = JSON.parse(source) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`PRD versions for ${prd.id} must be an array.`);
  return parsed.map(normalizePrdVersion);
}

async function appendPrdVersion(
  workingDir: string,
  prd: FactoryPrd,
  markdown: string,
  source: FactoryPrdVersion['source']
): Promise<void> {
  const versions = await readPrdVersions(workingDir, prd);
  const createdAt = new Date().toISOString();
  const version: FactoryPrdVersion = {
    id: `ver-${createdAt.replace(/[-:.TZ]/g, '')}`,
    prdId: prd.id,
    markdown: markdown.trim(),
    createdAt,
    source,
  };
  await writeFileEnsured(
    prdVersionsPath(workingDir, prd),
    `${JSON.stringify([...versions, version], null, 2)}\n`
  );
}

function prdVersionsPath(workingDir: string, prd: FactoryPrd): string {
  return join(workingDir, `${FACTORY_DIR}/prds/${prd.id}.versions.json`);
}

async function readStorySetFile(workingDir: string, prd: FactoryPrd): Promise<FactoryStorySet> {
  const source = await readOptionalFile(join(workingDir, prd.storiesPath));
  if (!source.trim()) return emptyStorySet(prd.id);
  const parsed = JSON.parse(source) as unknown;
  if (Array.isArray(parsed)) return buildStorySet(prd.id, parsed.map(normalizeStory), 'manual');
  return normalizeStorySet(parsed, prd.id);
}

async function writeStorySetFile(
  workingDir: string,
  prd: FactoryPrd,
  storySet: FactoryStorySet
): Promise<void> {
  await writeFileEnsured(
    join(workingDir, prd.storiesPath),
    `${JSON.stringify(normalizeStorySet(storySet, prd.id), null, 2)}\n`
  );
}

function emptyStorySet(prdId: string): FactoryStorySet {
  return { version: 1, prdId, status: 'not_started', source: 'manual', stories: [] };
}

function buildStorySet(
  prdId: string,
  stories: FactoryStory[],
  source: FactoryStorySetSource,
  status: FactoryStorySetStatus = stories.length > 0 ? 'draft' : 'not_started'
): FactoryStorySet {
  return {
    version: 1,
    prdId,
    status,
    source,
    generatedAt: new Date().toISOString(),
    stories: stories.map(normalizeStory),
  };
}

function ensurePrdApprovedForStories(prd: FactoryPrd): void {
  if (prd.status !== 'approved' && prd.status !== 'active') {
    throw new Error(`PRD must be approved before drafting stories: ${prd.id}`);
  }
}

function allowedFactoryActions(prd: FactoryPrd, storySet: FactoryStorySet): string[] {
  const actions: string[] = [];
  if (prd.workflowStage === 'prd_draft') actions.push('request-prd-review');
  if (prd.workflowStage === 'prd_review_requested') {
    actions.push('approve-prd', 'request-prd-changes');
  }
  if (
    (prd.status === 'approved' || prd.status === 'active') &&
    storySet.status !== 'approved' &&
    storySet.status !== 'imported'
  ) {
    actions.push('draft-stories');
  }
  if (storySet.status === 'draft' && storySet.stories.length > 0)
    actions.push('request-stories-review');
  if (storySet.status === 'review_requested') actions.push('approve-stories');
  if (storySet.status === 'approved') actions.push('import-stories');
  return actions;
}

function blockedFactoryReason(prd: FactoryPrd, storySet: FactoryStorySet): string | null {
  if (prd.workflowStage === 'stories_imported') return 'Stories are already imported.';
  if (storySet.status === 'not_started' && prd.status !== 'approved' && prd.status !== 'active') {
    return 'PRD approval is required before drafting stories.';
  }
  return null;
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeFileEnsured(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, 'utf-8');
}

function defaultPrdMarkdown(title: string, prompt: string): string {
  return `# PRD: ${title}

## Overview
${prompt || 'Describe the problem, target users, and intended outcome.'}

## Goals
- Define the measurable outcome for this work.

## Non-Goals
- List what is intentionally out of scope.

## User Stories
### US-001: First implementation slice
**Description:** As a user, I want the first valuable slice so that the feature can be validated incrementally.

**Acceptance Criteria:**
- [ ] The slice is independently usable.
- [ ] Required checks pass.

## Open Questions
- What must be clarified before execution?
`;
}

function normalizeStory(value: unknown): FactoryStory {
  if (!isRecord(value)) throw new Error('Story entries must be objects.');
  return {
    id: scalarString(value.id).trim(),
    title: scalarString(value.title).trim(),
    description: scalarString(value.description),
    acceptanceCriteria: Array.isArray(value.acceptanceCriteria)
      ? value.acceptanceCriteria.map(scalarString)
      : [],
    priority: Number(value.priority) || 1,
    status: value.status === 'todo' || value.status === 'backlog' ? value.status : 'draft',
    reviewStatus:
      value.reviewStatus === 'approved' || value.reviewStatus === 'rejected'
        ? value.reviewStatus
        : 'draft',
    dependsOn: Array.isArray(value.dependsOn) ? value.dependsOn.map(scalarString) : [],
    notes: scalarString(value.notes),
  };
}

function normalizeStorySet(value: unknown, prdId: string): FactoryStorySet {
  if (!isRecord(value)) throw new Error(`Stories file for ${prdId} must be an object or array.`);
  if (value.version !== 1) throw new Error(`Stories file version for ${prdId} must be 1.`);
  const status = STORY_SET_STATUSES.includes(value.status as FactoryStorySetStatus)
    ? (value.status as FactoryStorySetStatus)
    : 'not_started';
  const source = isStorySetSource(value.source) ? value.source : 'manual';
  const stories = Array.isArray(value.stories) ? value.stories.map(normalizeStory) : [];
  return {
    version: 1,
    prdId: scalarString(value.prdId) || prdId,
    status: stories.length === 0 && status !== 'imported' ? 'not_started' : status,
    source,
    generatedAt: optionalString(value.generatedAt),
    approvedAt: optionalString(value.approvedAt),
    importedAt: optionalString(value.importedAt),
    stories,
  };
}

function validatePrdIndex(value: unknown): asserts value is PrdIndex {
  if (!isRecord(value)) throw new Error('PRD index must be an object.');
  if (value.version !== 1) throw new Error('PRD index version must be 1.');
  if (!Array.isArray(value.prds)) throw new Error('PRD index prds must be an array.');
}

function normalizePrdIndex(value: unknown): PrdIndex {
  validatePrdIndex(value);
  return { version: 1, prds: value.prds.map(normalizePrd) };
}

function normalizePrd(value: unknown): FactoryPrd {
  if (!isRecord(value)) throw new Error('PRD index entries must be objects.');
  const status = PRD_STATUSES.includes(value.status as PrdStatus)
    ? (value.status as PrdStatus)
    : 'draft';
  return {
    id: scalarString(value.id).trim(),
    title: scalarString(value.title).trim(),
    status,
    description: scalarString(value.description ?? value.prompt),
    prdPath: scalarString(value.prdPath),
    storiesPath: scalarString(value.storiesPath),
    workflowStage: FACTORY_WORKFLOW_STAGES.includes(value.workflowStage as FactoryWorkflowStage)
      ? (value.workflowStage as FactoryWorkflowStage)
      : inferWorkflowStage(status),
    createdAt: scalarString(value.createdAt),
    updatedAt: scalarString(value.updatedAt),
  };
}

function inferWorkflowStage(status: PrdStatus): FactoryWorkflowStage {
  if (status === 'in_review') return 'prd_review_requested';
  if (status === 'approved') return 'prd_approved';
  if (status === 'active' || status === 'done') return 'stories_imported';
  return 'prd_draft';
}

function uniquePrdId(title: string, prds: FactoryPrd[]): string {
  const base = slugify(title) || 'prd';
  const existing = new Set(prds.map((prd) => prd.id));
  let id = base;
  let suffix = 2;
  while (existing.has(id)) id = `${base}-${suffix++}`;
  return id;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStorySetSource(value: unknown): value is FactoryStorySetSource {
  return value === 'agent' || value === 'manual';
}

function scalarString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function optionalString(value: unknown): string | undefined {
  const stringValue = scalarString(value);
  return stringValue || undefined;
}

function normalizePrdVersion(value: unknown): FactoryPrdVersion {
  if (!isRecord(value)) throw new Error('PRD version entries must be objects.');
  const source = value.source === 'create' || value.source === 'revert' ? value.source : 'update';
  return {
    id: scalarString(value.id),
    prdId: scalarString(value.prdId),
    markdown: scalarString(value.markdown),
    createdAt: scalarString(value.createdAt),
    source,
  };
}
