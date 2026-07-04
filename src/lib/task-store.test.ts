import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';
import { addTask, getTask, listTasks, updateTask } from './task-store.js';

describe('task-store', () => {
  it('adds tasks with deterministic ids and priorities', async () => {
    await withTempDir(async (dir) => {
      const first = await addTask(dir, { title: 'First task' });
      const second = await addTask(dir, { title: 'Second task' });

      expect(first.id).toBe('DRS-001');
      expect(second.id).toBe('DRS-002');
      expect(second.priority).toBe(2);
      expect(await listTasks(dir)).toHaveLength(2);
    });
  });

  it('updates task fields', async () => {
    await withTempDir(async (dir) => {
      const task = await addTask(dir, { title: 'Implement board' });
      const updated = await updateTask(dir, task.id, {
        status: 'ready_to_merge',
        acceptanceCriteria: ['Shows grouped columns'],
      });

      expect(updated.status).toBe('ready_to_merge');
      expect(updated.acceptanceCriteria).toEqual(['Shows grouped columns']);
      expect(await getTask(dir, task.id)).toMatchObject({
        status: 'ready_to_merge',
        acceptanceCriteria: ['Shows grouped columns'],
      });
    });
  });

  it('rejects dependencies that point at missing tasks', async () => {
    await withTempDir(async (dir) => {
      await expect(addTask(dir, { title: 'Blocked task', dependsOn: ['DRS-404'] })).rejects.toThrow(
        'depends on unknown task DRS-404'
      );
    });
  });
});

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'drs-task-store-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
