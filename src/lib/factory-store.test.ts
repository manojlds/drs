import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  approvePrd,
  approveStories,
  createPrd,
  deletePrd,
  draftStories,
  getFactoryWorkflowStatus,
  importStoriesToTasks,
  listPrdVersions,
  listPrds,
  requestPrdReview,
  requestStoriesReview,
  revertPrdVersion,
  updatePrdMarkdown,
  updatePrdStatus,
  updateStoryReviewStatus,
} from './factory-store.js';
import { listTasks } from './task-store.js';

describe('factory-store', () => {
  it('creates and lists durable PRDs', async () => {
    await withTempDir(async (dir) => {
      const created = await createPrd(dir, {
        title: 'Factory Planning',
        description: 'Plan factory',
      });
      const prds = await listPrds(dir);

      expect(created.prd.id).toBe('factory-planning');
      expect(created.markdown).toContain('# PRD: Factory Planning');
      expect(prds).toHaveLength(1);
    });
  });

  it('drafts structured stories and imports them as PRD-scoped tasks', async () => {
    await withTempDir(async (dir) => {
      const created = await createPrd(dir, { title: 'Example' });
      await approvePrd(dir, created.prd.id);
      const drafted = await draftStories(dir, created.prd.id, [
        story('US-001', 'Add PRD list', 'As a user, I want to list PRDs.', [
          'PRDs are listed in newest-first order.',
          'Required checks pass.',
        ]),
        story('US-002', 'Show PRD board', 'As a user, I want a scoped board.', [
          'Board filters tasks by PRD.',
        ]),
      ]);
      await updateStoryReviewStatus(dir, created.prd.id, 'US-001', 'approved');
      await updateStoryReviewStatus(dir, created.prd.id, 'US-002', 'approved');
      await approveStories(dir, created.prd.id);
      const imported = await importStoriesToTasks(dir, created.prd.id);
      const secondImport = await importStoriesToTasks(dir, created.prd.id);

      expect(drafted.stories.map((story) => story.title)).toEqual([
        'Add PRD list',
        'Show PRD board',
      ]);
      expect(imported).toHaveLength(2);
      expect(secondImport).toHaveLength(0);
      expect(imported[0]).toMatchObject({ prdId: created.prd.id, storyId: 'US-001' });
      expect(await listTasks(dir)).toHaveLength(2);
    });
  });

  it('requires approved PRDs and approved stories before import', async () => {
    await withTempDir(async (dir) => {
      const created = await createPrd(dir, { title: 'Gated Plan' });
      await expect(
        draftStories(dir, created.prd.id, [story('US-001', 'Approved work', 'Ready work.')])
      ).rejects.toThrow('PRD must be approved');

      await expect(importStoriesToTasks(dir, created.prd.id)).rejects.toThrow('must be approved');

      await updatePrdStatus(dir, created.prd.id, 'approved');
      await draftStories(dir, created.prd.id, [
        story('US-001', 'Approved work', 'Ready work.'),
        story('US-002', 'Rejected work', 'Not ready.'),
      ]);
      await updateStoryReviewStatus(dir, created.prd.id, 'US-001', 'approved');
      await updateStoryReviewStatus(dir, created.prd.id, 'US-002', 'rejected');
      await expect(importStoriesToTasks(dir, created.prd.id)).rejects.toThrow(
        'Stories must be approved'
      );
      await approveStories(dir, created.prd.id);
      const imported = await importStoriesToTasks(dir, created.prd.id);

      expect(imported).toHaveLength(1);
      expect(imported[0].storyId).toBe('US-001');
      expect(imported[0].status).toBe('backlog');
    });
  });

  it('versions PRD markdown writes and can revert', async () => {
    await withTempDir(async (dir) => {
      const created = await createPrd(dir, { title: 'Versioned Target', description: 'Original' });
      await updatePrdStatus(dir, created.prd.id, 'in_review');
      await updatePrdMarkdown(dir, created.prd.id, '# PRD: Versioned Target\n\nUpdated.\n');
      const versions = await listPrdVersions(dir, created.prd.id);
      const reverted = await revertPrdVersion(
        dir,
        created.prd.id,
        versions.at(-1)?.id ?? 'missing'
      );

      expect(versions.map((version) => version.source).sort()).toEqual(['create', 'update']);
      expect(reverted.markdown).toContain('Original');
      expect(await listPrdVersions(dir, created.prd.id)).toHaveLength(3);
    });
  });

  it('tracks explicit Factory coordinator stages', async () => {
    await withTempDir(async (dir) => {
      const created = await createPrd(dir, { title: 'Coordinator Plan' });

      expect(await getFactoryWorkflowStatus(dir, created.prd.id)).toMatchObject({
        stage: 'prd_draft',
        storySetStatus: 'not_started',
        allowedActions: expect.arrayContaining(['request-prd-review']),
      });

      await requestPrdReview(dir, created.prd.id);
      await approvePrd(dir, created.prd.id);
      await draftStories(dir, created.prd.id, [
        {
          id: 'US-001',
          title: 'Plan slice',
          description: 'As a planner, I want a slice.',
          acceptanceCriteria: ['The slice is reviewable.'],
          priority: 1,
          status: 'draft',
          reviewStatus: 'draft',
          dependsOn: [],
          notes: '',
        },
      ]);
      await requestStoriesReview(dir, created.prd.id);
      await approveStories(dir, created.prd.id);
      await importStoriesToTasks(dir, created.prd.id);

      expect(await getFactoryWorkflowStatus(dir, created.prd.id)).toMatchObject({
        stage: 'stories_imported',
        storySetStatus: 'imported',
      });
    });
  });

  it('deletes PRDs and their PRD-scoped artifacts', async () => {
    await withTempDir(async (dir) => {
      const created = await createPrd(dir, { title: 'Delete Me', description: 'Temporary plan' });
      await approvePrd(dir, created.prd.id);
      await draftStories(dir, created.prd.id, [story('US-001', 'Delete slice', 'Temporary work.')]);
      expect(await listPrdVersions(dir, created.prd.id)).toHaveLength(1);

      const deleted = await deletePrd(dir, created.prd.id);

      expect(deleted.id).toBe(created.prd.id);
      expect(await listPrds(dir)).toHaveLength(0);
      await expect(listPrdVersions(dir, created.prd.id)).rejects.toThrow('PRD not found');
      await expect(deletePrd(dir, created.prd.id)).rejects.toThrow('PRD not found');
    });
  });
});

function story(
  id: string,
  title: string,
  description: string,
  acceptanceCriteria: string[] = ['Implementation satisfies the story description.']
) {
  return {
    id,
    title,
    description,
    acceptanceCriteria,
    priority: Number(id.match(/\d+/)?.[0] ?? 1),
    status: 'draft' as const,
    reviewStatus: 'draft' as const,
    dependsOn: [],
    notes: '',
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'drs-factory-store-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
