import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  createPrd,
  deletePrd,
  generateStories,
  importStoriesToTasks,
  listPrdVersions,
  listPrds,
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

  it('generates stories from PRD markdown and imports them as PRD-scoped tasks', async () => {
    await withTempDir(async (dir) => {
      const markdown = `# PRD: Example

## User Stories
### US-001: Add PRD list
**Description:** As a user, I want to list PRDs.

**Acceptance Criteria:**
- [ ] PRDs are listed in newest-first order.
- [ ] Required checks pass.

### US-002: Show PRD board
**Description:** As a user, I want a scoped board.

**Acceptance Criteria:**
- [ ] Board filters tasks by PRD.
`;
      const created = await createPrd(dir, { title: 'Example', markdown });
      const generated = await generateStories(dir, created.prd.id);
      await updatePrdStatus(dir, created.prd.id, 'approved');
      await updateStoryReviewStatus(dir, created.prd.id, 'US-001', 'approved');
      await updateStoryReviewStatus(dir, created.prd.id, 'US-002', 'approved');
      const imported = await importStoriesToTasks(dir, created.prd.id);
      const secondImport = await importStoriesToTasks(dir, created.prd.id);

      expect(generated.stories.map((story) => story.title)).toEqual([
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
      const created = await createPrd(dir, {
        title: 'Gated Plan',
        markdown: `# PRD: Gated Plan

### US-001: Approved work
**Description:** Ready work.

### US-002: Rejected work
**Description:** Not ready.
`,
      });
      await generateStories(dir, created.prd.id);

      await expect(importStoriesToTasks(dir, created.prd.id)).rejects.toThrow('must be approved');

      await updatePrdStatus(dir, created.prd.id, 'approved');
      await updateStoryReviewStatus(dir, created.prd.id, 'US-001', 'approved');
      await updateStoryReviewStatus(dir, created.prd.id, 'US-002', 'rejected');
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

  it('deletes PRDs and their PRD-scoped artifacts', async () => {
    await withTempDir(async (dir) => {
      const created = await createPrd(dir, { title: 'Delete Me', description: 'Temporary plan' });
      await generateStories(dir, created.prd.id);
      expect(await listPrdVersions(dir, created.prd.id)).toHaveLength(1);

      const deleted = await deletePrd(dir, created.prd.id);

      expect(deleted.id).toBe(created.prd.id);
      expect(await listPrds(dir)).toHaveLength(0);
      await expect(listPrdVersions(dir, created.prd.id)).rejects.toThrow('PRD not found');
      await expect(deletePrd(dir, created.prd.id)).rejects.toThrow('PRD not found');
    });
  });
});

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'drs-factory-store-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
