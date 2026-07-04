import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

export const TASK_STORE_RELATIVE_PATH = '.drs/tasks/tasks.json';

export const TASK_STATUSES = [
  'draft',
  'open',
  'in_progress',
  'checks_failed',
  'in_review',
  'review_failed',
  'ready_to_merge',
  'merged',
  'done',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface DrsTaskSource {
  kind: 'manual' | 'github_issue' | 'gitlab_issue' | 'review_finding';
  id?: string;
  url?: string;
}

export interface DrsTaskAttempt {
  id: string;
  workflow?: string;
  status: 'running' | 'passed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  summary?: string;
}

export interface DrsTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  source: DrsTaskSource;
  acceptanceCriteria: string[];
  dependsOn: string[];
  workflow?: string;
  branch?: string;
  attempts: DrsTaskAttempt[];
  createdAt: string;
  updatedAt: string;
}

export interface DrsTaskStore {
  version: 1;
  items: DrsTask[];
}

export interface AddTaskInput {
  id?: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  workflow?: string;
  branch?: string;
  source?: DrsTaskSource;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  workflow?: string;
  branch?: string;
}

export async function listTasks(workingDir: string): Promise<DrsTask[]> {
  const store = await readTaskStore(workingDir);
  return [...store.items].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

export async function getTask(workingDir: string, id: string): Promise<DrsTask> {
  const task = (await listTasks(workingDir)).find((item) => item.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);
  return task;
}

export async function addTask(workingDir: string, input: AddTaskInput): Promise<DrsTask> {
  const title = input.title.trim();
  if (!title) throw new Error('Task title is required.');

  const store = await readTaskStore(workingDir);
  const now = new Date().toISOString();
  const explicitId = input.id?.trim();
  const id = explicitId ?? nextTaskId(store.items);
  if (!id) throw new Error('Task id is required.');
  if (store.items.some((task) => task.id === id)) throw new Error(`Task already exists: ${id}`);

  const task: DrsTask = {
    id,
    title,
    description: input.description?.trim() ?? '',
    status: normalizeTaskStatus(input.status ?? 'open'),
    priority: input.priority ?? nextPriority(store.items),
    source: input.source ?? { kind: 'manual' },
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    dependsOn: input.dependsOn ?? [],
    workflow: input.workflow,
    branch: input.branch,
    attempts: [],
    createdAt: now,
    updatedAt: now,
  };

  const next = { ...store, items: [...store.items, task] };
  await writeTaskStore(workingDir, next);
  return task;
}

export async function updateTask(
  workingDir: string,
  id: string,
  input: UpdateTaskInput
): Promise<DrsTask> {
  const store = await readTaskStore(workingDir);
  const index = store.items.findIndex((task) => task.id === id);
  if (index === -1) throw new Error(`Task not found: ${id}`);

  const current = store.items[index];
  const updated: DrsTask = {
    ...current,
    ...definedFields(input),
    status: input.status ? normalizeTaskStatus(input.status) : current.status,
    updatedAt: new Date().toISOString(),
  };
  if (!updated.title.trim()) throw new Error('Task title cannot be empty.');

  const items = [...store.items];
  items[index] = updated;
  await writeTaskStore(workingDir, { ...store, items });
  return updated;
}

export async function validateTaskStore(
  workingDir: string
): Promise<{ valid: true; count: number }> {
  const store = await readTaskStore(workingDir);
  validateStore(store);
  return { valid: true, count: store.items.length };
}

export async function readTaskStore(workingDir: string): Promise<DrsTaskStore> {
  const path = taskStorePath(workingDir);
  try {
    const source = await readFile(path, 'utf-8');
    const parsed = JSON.parse(source) as unknown;
    validateStore(parsed);
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { version: 1, items: [] };
    throw error;
  }
}

export async function writeTaskStore(workingDir: string, store: DrsTaskStore): Promise<void> {
  validateStore(store);
  const path = taskStorePath(workingDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

export function taskStorePath(workingDir: string): string {
  return join(workingDir, TASK_STORE_RELATIVE_PATH);
}

export function normalizeTaskStatus(status: string): TaskStatus {
  if (TASK_STATUSES.includes(status as TaskStatus)) return status as TaskStatus;
  throw new Error(`Invalid task status "${status}". Expected one of: ${TASK_STATUSES.join(', ')}`);
}

function validateStore(value: unknown): asserts value is DrsTaskStore {
  if (!isRecord(value)) throw new Error('Task store must be a JSON object.');
  if (value.version !== 1) throw new Error('Task store version must be 1.');
  if (!Array.isArray(value.items)) throw new Error('Task store items must be an array.');
  const ids = new Set<string>();
  for (const item of value.items) {
    validateTask(item);
    if (ids.has(item.id)) throw new Error(`Duplicate task id: ${item.id}`);
    ids.add(item.id);
  }
  for (const item of value.items) {
    for (const dependency of item.dependsOn) {
      if (dependency === item.id) throw new Error(`Task ${item.id} cannot depend on itself.`);
      if (!ids.has(dependency))
        throw new Error(`Task ${item.id} depends on unknown task ${dependency}.`);
    }
  }
}

function validateTask(value: unknown): asserts value is DrsTask {
  if (!isRecord(value)) throw new Error('Task entries must be objects.');
  if (typeof value.id !== 'string' || !value.id.trim()) throw new Error('Task id is required.');
  if (typeof value.title !== 'string' || !value.title.trim()) {
    throw new Error(`Task ${value.id} title is required.`);
  }
  normalizeTaskStatus(String(value.status));
  if (!Array.isArray(value.acceptanceCriteria)) {
    throw new Error(`Task ${value.id} acceptanceCriteria must be an array.`);
  }
  if (!Array.isArray(value.dependsOn))
    throw new Error(`Task ${value.id} dependsOn must be an array.`);
  if (!Array.isArray(value.attempts))
    throw new Error(`Task ${value.id} attempts must be an array.`);
}

function nextTaskId(tasks: DrsTask[]): string {
  const max = tasks.reduce((highest, task) => {
    const match = task.id.match(/^DRS-(\d+)$/);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `DRS-${String(max + 1).padStart(3, '0')}`;
}

function nextPriority(tasks: DrsTask[]): number {
  return tasks.reduce((highest, task) => Math.max(highest, task.priority), 0) + 1;
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
