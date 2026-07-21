import type { AgentWorkspaceChanges } from './agent-permissions.js';
import type { OkfBundleValidationResult } from './okf-wiki.js';
import {
  createEmptyUsageSummary,
  type AgentUsageSummary,
  type UsageSummary,
} from './review-usage.js';
import type { WikiUpdatePlan } from './wiki-delta.js';

export interface WikiRunSummary {
  mode: WikiUpdatePlan['mode'];
  changedSourceCount: number;
  concepts: {
    total: number;
    added: number;
    edited: number;
    deleted: number;
  };
  validation: {
    errors: number;
    warnings: number;
  };
  graph: OkfBundleValidationResult['graph'];
  provenance: {
    coveredConcepts: number;
    uncoveredConcepts: number;
    coverage: number;
  };
  model: {
    invoked: boolean;
    id?: string;
    turns: number;
    usage: UsageSummary;
  };
  elapsedMs: number;
  instructionsHash?: string;
}

export interface CreateWikiRunSummaryOptions {
  plan: WikiUpdatePlan;
  validation: OkfBundleValidationResult;
  modelInvoked: boolean;
  usage?: AgentUsageSummary;
  workspaceChanges?: AgentWorkspaceChanges;
  elapsedMs: number;
}

export function createWikiRunSummary(options: CreateWikiRunSummaryOptions): WikiRunSummary {
  const { plan, validation, workspaceChanges } = options;
  const missingProvenance = new Set(
    validation.warnings
      .filter((warning) => warning.code === 'missing_provenance' && warning.path)
      .map((warning) => warning.path as string)
  ).size;
  const uncoveredConcepts = Math.min(validation.concepts, missingProvenance);
  const conceptChanges = countConceptChanges(validation.root, workspaceChanges);

  return {
    mode: plan.mode,
    changedSourceCount: plan.changedPathCount,
    concepts: {
      total: validation.concepts,
      ...conceptChanges,
    },
    validation: {
      errors: validation.errors.length,
      warnings: validation.warnings.length,
    },
    graph: validation.graph,
    provenance: {
      coveredConcepts: validation.concepts - uncoveredConcepts,
      uncoveredConcepts,
      coverage:
        validation.concepts === 0
          ? 0
          : (validation.concepts - uncoveredConcepts) / validation.concepts,
    },
    model: {
      invoked: options.modelInvoked,
      ...(options.usage?.model ? { id: options.usage.model } : {}),
      turns: options.usage?.turns ?? 0,
      usage: options.usage?.usage ?? createEmptyUsageSummary(),
    },
    elapsedMs: Math.max(0, Math.round(options.elapsedMs)),
    ...(plan.instructionsHash ? { instructionsHash: plan.instructionsHash } : {}),
  };
}

export function formatWikiRunSummaryHuman(summary: WikiRunSummary): string {
  return [
    'Repository wiki summary',
    `Mode: ${summary.mode}`,
    `Changed sources: ${summary.changedSourceCount}`,
    `Concepts: ${summary.concepts.total} total, ${summary.concepts.added} added, ${summary.concepts.edited} edited, ${summary.concepts.deleted} deleted`,
    `Validation: ${summary.validation.errors} errors, ${summary.validation.warnings} warnings`,
    `Graph: ${formatGraph(summary)}`,
    `Provenance: ${formatProvenance(summary)}`,
    `Model: ${formatModel(summary)}`,
    `Elapsed: ${formatElapsed(summary.elapsedMs)}`,
    `Instructions hash: ${summary.instructionsHash ?? 'none'}`,
  ].join('\n');
}

export function formatWikiRunSummaryMarkdown(summary: WikiRunSummary): string {
  const rows = [
    ['Mode', summary.mode],
    ['Changed sources', String(summary.changedSourceCount)],
    [
      'Concepts',
      `${summary.concepts.total} total; ${summary.concepts.added} added, ${summary.concepts.edited} edited, ${summary.concepts.deleted} deleted`,
    ],
    ['Validation', `${summary.validation.errors} errors, ${summary.validation.warnings} warnings`],
    ['Graph', formatGraph(summary)],
    ['Provenance', formatProvenance(summary)],
    ['Model', formatModel(summary)],
    ['Elapsed', formatElapsed(summary.elapsedMs)],
    ['Instructions hash', summary.instructionsHash ?? 'none'],
  ];

  return [
    '## Repository wiki summary',
    '',
    '| Metric | Result |',
    '| --- | --- |',
    ...rows.map(
      ([label, value]) =>
        `| ${escapeMarkdownTableCell(label)} | ${escapeMarkdownTableCell(value)} |`
    ),
    '',
    'Automated repository wiki update generated from the latest default branch.',
    '',
    'If the base branch moves before merge, rerun this workflow to refresh the wiki and deterministic state.',
    '',
  ].join('\n');
}

export function getWikiRunSummary(value: unknown): WikiRunSummary | undefined {
  if (!isRecord(value) || !isRecord(value.summary)) return undefined;
  const summary = value.summary;
  if (
    !['generate', 'reconcile', 'update', 'noop'].includes(String(summary.mode)) ||
    !isNumber(summary.changedSourceCount) ||
    !isRecord(summary.concepts) ||
    !hasNumbers(summary.concepts, ['total', 'added', 'edited', 'deleted']) ||
    !isRecord(summary.validation) ||
    !hasNumbers(summary.validation, ['errors', 'warnings']) ||
    !isRecord(summary.graph) ||
    !hasNumbers(summary.graph, [
      'nodeCount',
      'directedEdgeCount',
      'orphanConceptCount',
      'weaklyConnectedConceptCount',
    ]) ||
    !isRecord(summary.provenance) ||
    !hasNumbers(summary.provenance, ['coveredConcepts', 'uncoveredConcepts', 'coverage']) ||
    !isRecord(summary.model) ||
    typeof summary.model.invoked !== 'boolean' ||
    !isNumber(summary.model.turns) ||
    !isRecord(summary.model.usage) ||
    !hasNumbers(summary.model.usage, [
      'input',
      'output',
      'cacheRead',
      'cacheWrite',
      'totalTokens',
      'cost',
    ]) ||
    (summary.model.id !== undefined && typeof summary.model.id !== 'string') ||
    !isNumber(summary.elapsedMs) ||
    (summary.instructionsHash !== undefined && typeof summary.instructionsHash !== 'string')
  ) {
    return undefined;
  }
  return summary as unknown as WikiRunSummary;
}

function countConceptChanges(
  root: string,
  changes: AgentWorkspaceChanges | undefined
): Pick<WikiRunSummary['concepts'], 'added' | 'edited' | 'deleted'> {
  const isConcept = (filePath: string): boolean => {
    const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/u, '');
    const prefix = `${normalizedRoot}/`;
    if (!filePath.startsWith(prefix) || !filePath.endsWith('.md')) return false;
    const filename = filePath.slice(filePath.lastIndexOf('/') + 1);
    return filename !== 'index.md' && filename !== 'log.md';
  };

  return {
    added: changes?.added.filter(isConcept).length ?? 0,
    edited: changes?.modified.filter(isConcept).length ?? 0,
    deleted: changes?.deleted.filter(isConcept).length ?? 0,
  };
}

function formatProvenance(summary: WikiRunSummary): string {
  const { coveredConcepts, uncoveredConcepts, coverage } = summary.provenance;
  return `${coveredConcepts}/${coveredConcepts + uncoveredConcepts} concepts (${(coverage * 100).toFixed(1)}%)`;
}

function formatGraph(summary: WikiRunSummary): string {
  return `${summary.graph.nodeCount} concepts, ${summary.graph.directedEdgeCount} directed links, ${summary.graph.orphanConceptCount} orphans, ${summary.graph.weaklyConnectedConceptCount} weakly connected`;
}

function formatModel(summary: WikiRunSummary): string {
  if (!summary.model.invoked) return 'not invoked';
  const id = summary.model.id ?? 'unknown model';
  const usage = summary.model.usage;
  return `${id}, ${summary.model.turns} turns, ${usage.totalTokens} tokens (${usage.input} input, ${usage.output} output, ${usage.cacheRead} cache read, ${usage.cacheWrite} cache write), $${usage.cost.toFixed(4)}`;
}

function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/[\\`*_[\]<>|]/gu, '\\$&')
    .trim();
}

function hasNumbers(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => isNumber(value[field]));
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
