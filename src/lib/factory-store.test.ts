import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  createPrd,
  createProposal,
  applyProposal,
  discardProposal,
  generateStories,
  importStoriesToTasks,
  listProposals,
  listPrds,
  updatePrdStatus,
  updateStoryReviewStatus,
} from './factory-store.js';
import { listTasks } from './task-store.js';

describe('factory-store', () => {
  it('creates and lists durable PRDs', async () => {
    await withTempDir(async (dir) => {
      const created = await createPrd(dir, { title: 'Factory Planning', prompt: 'Plan factory' });
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

  it('creates, applies, and discards planning proposals', async () => {
    await withTempDir(async (dir) => {
      const created = await createPrd(dir, { title: 'Proposal Target', prompt: 'Original' });
      const proposal = await createProposal(dir, {
        prdId: created.prd.id,
        title: 'Sharper PRD',
        summary: 'Replace the draft with a clearer PRD.',
        markdown: '# PRD: Proposal Target\n\n## Overview\nUpdated by proposal.\n',
        createdBy: 'test-agent',
      });
      const spare = await createProposal(dir, {
        title: 'Unused Alternative',
        markdown: '# PRD: Alternative\n',
      });

      const applied = await applyProposal(dir, proposal.id);
      const discarded = await discardProposal(dir, spare.id);
      const proposals = await listProposals(dir);

      expect(applied.markdown).toContain('Updated by proposal');
      expect(applied.proposal.status).toBe('applied');
      expect(discarded.status).toBe('discarded');
      expect(proposals.map((item) => item.status).sort()).toEqual(['applied', 'discarded']);
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
