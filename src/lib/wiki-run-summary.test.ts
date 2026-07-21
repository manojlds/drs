import { describe, expect, it } from 'vitest';
import type { OkfBundleValidationResult } from './okf-wiki.js';
import type { WikiUpdatePlan } from './wiki-delta.js';
import {
  createWikiRunSummary,
  formatWikiRunSummaryHuman,
  formatWikiRunSummaryMarkdown,
  getWikiRunSummary,
} from './wiki-run-summary.js';

const plan: WikiUpdatePlan = {
  mode: 'update',
  shouldRun: true,
  reason: 'source changed',
  root: 'wiki',
  statePath: '.drs/wiki-state.json',
  gitHead: 'abc123',
  sourceHash: 'source',
  changedPaths: ['src/app.ts', 'src/runtime.ts'],
  changedPathCount: 2,
  changedPathsTruncated: false,
  candidateConcepts: ['architecture.md'],
  instructions: '',
  instructionsSource: 'file',
  instructionsHash: 'instructions-hash',
};

const validation: OkfBundleValidationResult = {
  valid: true,
  version: '0.1',
  root: 'wiki',
  concepts: 4,
  indexes: 1,
  logs: 1,
  errors: [],
  graph: {
    nodeCount: 4,
    directedEdgeCount: 5,
    orphanConceptCount: 1,
    weaklyConnectedConceptCount: 2,
  },
  warnings: [
    {
      code: 'missing_provenance',
      message: 'Missing provenance.',
      path: 'missing.md',
    },
    { code: 'orphan_concept', message: 'Orphan.', path: 'missing.md' },
  ],
};

describe('wiki run summary', () => {
  it('combines deterministic run, graph, provenance, change, and usage metrics', () => {
    const summary = createWikiRunSummary({
      plan,
      validation,
      modelInvoked: true,
      usage: {
        agentType: 'task/okf-wiki-maintainer',
        model: 'provider/model',
        success: true,
        turns: 2,
        usage: {
          input: 10,
          output: 5,
          cacheRead: 3,
          cacheWrite: 0,
          totalTokens: 18,
          cost: 0.0123,
        },
      },
      workspaceChanges: {
        added: ['wiki/new.md', 'wiki/index.md', 'outside.md'],
        modified: ['wiki/architecture/runtime.md'],
        deleted: ['wiki/old.md', 'wiki/log.md'],
      },
      elapsedMs: 4250.4,
    });

    expect(summary).toMatchObject({
      mode: 'update',
      changedSourceCount: 2,
      concepts: { total: 4, added: 1, edited: 1, deleted: 1 },
      validation: { errors: 0, warnings: 2 },
      provenance: { coveredConcepts: 3, uncoveredConcepts: 1, coverage: 0.75 },
      model: {
        invoked: true,
        id: 'provider/model',
        turns: 2,
        usage: { totalTokens: 18, cost: 0.0123 },
      },
      elapsedMs: 4250,
      instructionsHash: 'instructions-hash',
    });
    expect(formatWikiRunSummaryHuman(summary)).toContain(
      'Concepts: 4 total, 1 added, 1 edited, 1 deleted'
    );
    expect(formatWikiRunSummaryMarkdown(summary)).toContain(
      '| Model | provider/model, 2 turns, 18 tokens (10 input, 5 output, 3 cache read, 0 cache write), $0.0123 |'
    );
    expect(getWikiRunSummary({ valid: true, summary })).toEqual(summary);
  });

  it('reports model-free no-op runs with zero changes and escapes Markdown values', () => {
    const summary = createWikiRunSummary({
      plan: { ...plan, mode: 'noop', shouldRun: false, changedPathCount: 0 },
      validation,
      modelInvoked: false,
      elapsedMs: 12,
    });
    expect(summary.concepts).toEqual({ total: 4, added: 0, edited: 0, deleted: 0 });
    expect(summary.model).toMatchObject({ invoked: false, turns: 0, usage: { totalTokens: 0 } });
    expect(formatWikiRunSummaryHuman(summary)).toContain('Model: not invoked');

    const unsafe = {
      ...summary,
      model: { ...summary.model, invoked: true, id: 'provider/model|injected\nrow' },
    };
    const markdown = formatWikiRunSummaryMarkdown(unsafe);
    expect(markdown).toContain('provider/model\\|injected row');
    expect(markdown).not.toContain('injected\nrow');
    expect(getWikiRunSummary({ summary: { mode: 'noop', changedSourceCount: 0 } })).toBeUndefined();
  });
});
