import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { addTask, listTasks, type DrsTask } from './task-store.js';

export const FACTORY_DIR = '.drs/factory';
export const PRD_INDEX_RELATIVE_PATH = `${FACTORY_DIR}/prds/index.json`;

export const PRD_STATUSES = ['draft', 'active', 'paused', 'done', 'archived'] as const;
export type PrdStatus = (typeof PRD_STATUSES)[number];

export interface FactoryPrd {
  id: string;
  title: string;
  status: PrdStatus;
  prompt: string;
  prdPath: string;
  storiesPath: string;
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
  dependsOn: string[];
  notes: string;
}

export interface PrdIndex {
  version: 1;
  prds: FactoryPrd[];
}

export async function listPrds(workingDir: string): Promise<FactoryPrd[]> {
  const index = await readPrdIndex(workingDir);
  return [...index.prds].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getPrd(
  workingDir: string,
  id: string
): Promise<{ prd: FactoryPrd; markdown: string; stories: FactoryStory[] }> {
  const prd = await findPrd(workingDir, id);
  const markdown = await readOptionalFile(join(workingDir, prd.prdPath));
  const stories = await readStoriesFile(workingDir, prd);
  return { prd, markdown, stories };
}

export async function createPrd(
  workingDir: string,
  input: { title: string; prompt?: string; markdown?: string; status?: PrdStatus }
): Promise<{ prd: FactoryPrd; markdown: string; stories: FactoryStory[] }> {
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
    prompt: input.prompt?.trim() ?? '',
    prdPath,
    storiesPath,
    createdAt: now,
    updatedAt: now,
  };
  const markdownInput = input.markdown?.trim();
  let markdown = defaultPrdMarkdown(title, prd.prompt);
  if (markdownInput && markdownInput.length > 0) markdown = markdownInput;
  await writeFileEnsured(join(workingDir, prdPath), `${markdown.trim()}\n`);
  await writeStoriesFile(workingDir, prd, []);
  await writePrdIndex(workingDir, { version: 1, prds: [...index.prds, prd] });
  return { prd, markdown, stories: [] };
}

export async function updatePrdMarkdown(
  workingDir: string,
  id: string,
  markdown: string
): Promise<{ prd: FactoryPrd; markdown: string; stories: FactoryStory[] }> {
  const index = await readPrdIndex(workingDir);
  const prdIndex = index.prds.findIndex((item) => item.id === id);
  if (prdIndex === -1) throw new Error(`PRD not found: ${id}`);
  const prd = { ...index.prds[prdIndex], updatedAt: new Date().toISOString() };
  const prds = [...index.prds];
  prds[prdIndex] = prd;
  await writeFileEnsured(join(workingDir, prd.prdPath), `${markdown.trim()}\n`);
  await writePrdIndex(workingDir, { version: 1, prds });
  return getPrd(workingDir, id);
}

export async function generateStories(
  workingDir: string,
  id: string
): Promise<{ prd: FactoryPrd; markdown: string; stories: FactoryStory[] }> {
  const current = await getPrd(workingDir, id);
  const stories = parseStoriesFromMarkdown(current.markdown);
  await writeStoriesFile(workingDir, current.prd, stories);
  return { ...current, stories };
}

export async function importStoriesToTasks(workingDir: string, id: string): Promise<DrsTask[]> {
  const { prd, stories } = await getPrd(workingDir, id);
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
  for (const story of stories) {
    if (existingByStory.has(story.id)) continue;
    const task = await addTask(workingDir, {
      prdId: prd.id,
      storyId: story.id,
      title: story.title,
      description: story.description,
      status: story.status,
      priority: story.priority,
      acceptanceCriteria: story.acceptanceCriteria,
      dependsOn: story.dependsOn.map((storyId) => storyToTask.get(storyId)).filter(isString),
      source: { kind: 'manual', id: `${prd.id}:${story.id}` },
    });
    storyToTask.set(story.id, task.id);
    created.push(task);
  }
  return created;
}

export function prdIndexPath(workingDir: string): string {
  return join(workingDir, PRD_INDEX_RELATIVE_PATH);
}

async function readPrdIndex(workingDir: string): Promise<PrdIndex> {
  try {
    const source = await readFile(prdIndexPath(workingDir), 'utf-8');
    const parsed = JSON.parse(source) as unknown;
    validatePrdIndex(parsed);
    return parsed;
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

async function readStoriesFile(workingDir: string, prd: FactoryPrd): Promise<FactoryStory[]> {
  const source = await readOptionalFile(join(workingDir, prd.storiesPath));
  if (!source.trim()) return [];
  const parsed = JSON.parse(source) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Stories file for ${prd.id} must be an array.`);
  return parsed.map(normalizeStory);
}

async function writeStoriesFile(
  workingDir: string,
  prd: FactoryPrd,
  stories: FactoryStory[]
): Promise<void> {
  await writeFileEnsured(
    join(workingDir, prd.storiesPath),
    `${JSON.stringify(stories, null, 2)}\n`
  );
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

function parseStoriesFromMarkdown(markdown: string): FactoryStory[] {
  const lines = markdown.split('\n');
  const headingIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^#{2,4}\s+(?:US-\d+[:.)\s-]+)?/.test(line));
  const storyHeadings = headingIndexes.filter(({ line }) =>
    /(?:^#{2,4}\s+US-\d+|story)/i.test(line)
  );
  const headings = storyHeadings.length > 0 ? storyHeadings : headingIndexes;
  return headings.slice(0, 20).map(({ line, index }, storyIndex) => {
    const next = headings[storyIndex + 1]?.index ?? lines.length;
    const body = lines
      .slice(index + 1, next)
      .join('\n')
      .trim();
    const title = line
      .replace(/^#{2,4}\s+/, '')
      .replace(/^US-\d+[:.)\s-]*/i, '')
      .trim();
    return {
      id: `US-${String(storyIndex + 1).padStart(3, '0')}`,
      title: title || `Story ${storyIndex + 1}`,
      description: extractDescription(body),
      acceptanceCriteria: extractAcceptanceCriteria(body),
      priority: storyIndex + 1,
      status: 'draft',
      dependsOn: [],
      notes: '',
    };
  });
}

function extractDescription(body: string): string {
  const description = body.match(/\*\*Description:\*\*\s*([^\n]+)/i)?.[1]?.trim();
  if (description) return description;
  return (
    body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('-') && !/^\*\*Acceptance/i.test(line)) ?? ''
  );
}

function extractAcceptanceCriteria(body: string): string[] {
  const lines = body.split('\n');
  const criteria = lines
    .map((line) => line.trim())
    .filter((line) => /^- \[[ xX]?\]\s+/.test(line) || /^-\s+/.test(line))
    .map((line) =>
      line
        .replace(/^- \[[ xX]?\]\s+/, '')
        .replace(/^-\s+/, '')
        .trim()
    )
    .filter(Boolean);
  return criteria.length > 0 ? criteria : ['Implementation satisfies the story description.'];
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
    dependsOn: Array.isArray(value.dependsOn) ? value.dependsOn.map(scalarString) : [],
    notes: scalarString(value.notes),
  };
}

function validatePrdIndex(value: unknown): asserts value is PrdIndex {
  if (!isRecord(value)) throw new Error('PRD index must be an object.');
  if (value.version !== 1) throw new Error('PRD index version must be 1.');
  if (!Array.isArray(value.prds)) throw new Error('PRD index prds must be an array.');
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

function scalarString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
