import type { WorkflowConfig, WorkflowNodeConfig } from '../config.js';
import type { WorkflowNodeResult, WorkflowTemplateContext } from './types.js';

export function getNodeNeeds(node: WorkflowNodeConfig): string[] {
  if (node.needs === undefined) {
    return [];
  }

  if (!Array.isArray(node.needs)) {
    throw new Error('Workflow node "needs" must be an array of node ids.');
  }

  return node.needs;
}

export function getControlTargets(node: WorkflowNodeConfig): string[] {
  const targets: string[] = [];
  if (node.target) targets.push(node.target);
  if (node.exit) targets.push(node.exit);
  if (node.default) targets.push(node.default);
  if (node.cases) targets.push(...Object.values(node.cases));
  return targets;
}

export function validateWorkflowControlTargets(nodes: Record<string, WorkflowNodeConfig>): void {
  for (const [nodeId, node] of Object.entries(nodes)) {
    for (const target of getControlTargets(node)) {
      if (!nodes[target]) {
        throw new Error(`Workflow node "${nodeId}" targets unknown node "${target}".`);
      }
    }
  }
}

export function validateWorkflowControlRouteDirection(
  nodes: Record<string, WorkflowNodeConfig>,
  executionOrder: string[]
): void {
  const segments = splitWorkflowSegments(nodes, executionOrder);
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    if (segment.type !== 'control') {
      continue;
    }
    const node = nodes[segment.nodeId];
    if (!node || node.control === 'loop') {
      continue;
    }
    for (const target of getControlTargets(node)) {
      const targetIndex = findWorkflowSegmentIndex(segments, target);
      if (targetIndex <= segmentIndex) {
        throw new Error(
          `Workflow control node "${segment.nodeId}" cannot jump backward to "${target}". Use control: loop with maxIterations for repeated execution.`
        );
      }
    }
  }
}

export function validateWorkflowPassThroughShape(nodeId: string, node: WorkflowNodeConfig): void {
  if (node.control !== 'passThrough') {
    return;
  }
  if (!node.target) {
    throw new Error(`Workflow passThrough node "${nodeId}" must define "target".`);
  }
  const forbiddenKeys = [
    'if',
    'then',
    'else',
    'exit',
    'cases',
    'default',
    'maxIterations',
    'onMaxIterations',
    'value',
  ];
  const extraFields = forbiddenKeys.filter((key) => key in node);
  if (extraFields.length > 0) {
    throw new Error(
      `Workflow passThrough node "${nodeId}" must not define extra control logic: ${extraFields.join(', ')}.`
    );
  }
}

export const WORKFLOW_NODE_FIELDS = new Set([
  'agent',
  'agentsFrom',
  'control',
  'action',
  'with',
  'needs',
  'if',
  'target',
  'exit',
  'maxIterations',
  'onMaxIterations',
  'value',
  'cases',
  'default',
  'input',
  'output',
  'writes',
  'json',
]);

export const EXECUTABLE_NODE_FIELDS = new Set([
  'agent',
  'agentsFrom',
  'action',
  'with',
  'needs',
  'if',
  'input',
  'output',
  'writes',
  'json',
]);

export const CONTROL_NODE_FIELDS: Record<string, Set<string>> = {
  loop: new Set([
    'control',
    'needs',
    'if',
    'target',
    'exit',
    'maxIterations',
    'onMaxIterations',
    'output',
  ]),
  switch: new Set(['control', 'needs', 'value', 'cases', 'default', 'output']),
  end: new Set(['control', 'needs', 'output']),
  passThrough: new Set(['control', 'needs', 'target', 'output']),
};

export const ACTION_OPTION_FIELDS: Partial<
  Record<NonNullable<WorkflowNodeConfig['action']>, Set<string>>
> = {
  write: new Set(),
  'git-diff': new Set(['staged']),
  'git-add': new Set(['path', 'paths']),
  'git-branch': new Set(['name', 'from', 'force']),
  'git-commit': new Set(['message', 'path', 'paths']),
  'git-push': new Set(['remote', 'branch', 'remoteBranch', 'setUpstream', 'force']),
  'has-diff': new Set(['path', 'paths']),
  'stack-guard': new Set(['source', 'allowStackedSource', 'reservedPrefixes']),
  'review-threshold': new Set(['review', 'severity', 'minIssues']),
  'save-artifact': new Set([
    'kind',
    'source',
    'artifact',
    'payload',
    'platform',
    'project',
    'projectId',
    'owner',
    'repo',
    'subject',
    'changeKind',
    'changeNumber',
    'pr',
    'mr',
    'branch',
  ]),
  'load-artifact': new Set([
    'kind',
    'source',
    'id',
    'platform',
    'project',
    'projectId',
    'owner',
    'repo',
    'subject',
    'changeKind',
    'changeNumber',
    'pr',
    'mr',
    'branch',
  ]),
  'artifact-exists': new Set([
    'kind',
    'source',
    'id',
    'platform',
    'project',
    'projectId',
    'owner',
    'repo',
    'subject',
    'changeKind',
    'changeNumber',
    'pr',
    'mr',
    'branch',
  ]),
  'create-review-artifact': new Set(['source', 'review']),
  'review-artifact-status': new Set(['artifact']),
  'review-artifact-add-finding': new Set(['artifact', 'issue', 'source']),
  'review-artifact-update-findings': new Set([
    'artifact',
    'state',
    'disposition',
    'ids',
    'fingerprints',
    'severity',
  ]),
  'review-artifact-promote-finding': new Set(['artifact', 'ids', 'fingerprints', 'severity']),
  'review-artifact-resolve-finding': new Set(['artifact', 'ids', 'fingerprints', 'severity']),
  'verify-fix': new Set(['artifact', 'review', 'fixChange', 'severity', 'minIssues']),
  'create-change-request': new Set([
    'platform',
    'owner',
    'repo',
    'project',
    'projectId',
    'sourceBranch',
    'head',
    'targetBranch',
    'base',
    'title',
    'body',
    'draft',
    'reuseExisting',
  ]),
  'create-pr': new Set([
    'platform',
    'owner',
    'repo',
    'project',
    'projectId',
    'sourceBranch',
    'head',
    'targetBranch',
    'base',
    'title',
    'body',
    'draft',
    'reuseExisting',
  ]),
  'create-mr': new Set([
    'platform',
    'owner',
    'repo',
    'project',
    'projectId',
    'sourceBranch',
    'head',
    'targetBranch',
    'base',
    'title',
    'body',
    'draft',
    'reuseExisting',
  ]),
  'change-source': new Set([
    'type',
    'staged',
    'from',
    'to',
    'includePrereleaseFrom',
    'owner',
    'repo',
    'pr',
    'project',
    'projectId',
    'mr',
    'mrIid',
    'source',
    'fixChange',
  ]),
  review: new Set(['source', 'reviewArtifact', 'severity', 'artifact']),
  'review-context': new Set(['source', 'file', 'baseBranch']),
  describe: new Set(['source', 'post', 'postDescription']),
  'code-quality-report': new Set(['review', 'path']),
  'sync-okf-indexes': new Set(['root', 'version']),
  'validate-okf-wiki': new Set(['root', 'version']),
  'post-comment': new Set([
    'source',
    'platform',
    'owner',
    'repo',
    'project',
    'projectId',
    'pr',
    'mr',
    'prNumber',
    'mrIid',
    'body',
    'marker',
  ]),
  'post-review-comments': new Set(['source', 'review', 'removeErrorComment']),
  'post-fix-status': new Set([
    'platform',
    'owner',
    'repo',
    'project',
    'projectId',
    'pr',
    'mr',
    'source',
    'reviewArtifact',
    'fixReview',
    'fixChange',
    'severity',
    'stackedPrUrl',
    'marker',
  ]),
};

export function validateAllowedFields(
  nodeId: string,
  value: Record<string, unknown>,
  allowed: Set<string>,
  subject: string
): void {
  const unknownFields = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknownFields.length > 0) {
    throw new Error(
      `Workflow ${subject} "${nodeId}" has unsupported field(s): ${unknownFields.join(', ')}.`
    );
  }
}

export function validateWorkflowNodeShape(nodeId: string, node: WorkflowNodeConfig): void {
  validateAllowedFields(
    nodeId,
    node as unknown as Record<string, unknown>,
    WORKFLOW_NODE_FIELDS,
    'node'
  );
  const kind = getNodeKind(node);

  if (kind === 'control') {
    const control = node.control;
    if (!control || !CONTROL_NODE_FIELDS[control]) {
      throw new Error(
        `Workflow control node "${nodeId}" has unsupported control "${String(control)}".`
      );
    }
    validateAllowedFields(
      nodeId,
      node as unknown as Record<string, unknown>,
      CONTROL_NODE_FIELDS[control],
      'control node'
    );
    return;
  }

  validateAllowedFields(
    nodeId,
    node as unknown as Record<string, unknown>,
    EXECUTABLE_NODE_FIELDS,
    'node'
  );
  if (node.action && node.with) {
    const allowed = ACTION_OPTION_FIELDS[node.action];
    if (!allowed) {
      throw new Error(`Workflow action node "${nodeId}" has unsupported action "${node.action}".`);
    }
    validateAllowedFields(nodeId, node.with, allowed, `node "${nodeId}" with`);
  }
}

export function validateWorkflowNodeKinds(nodes: Record<string, WorkflowNodeConfig>): void {
  for (const [nodeId, node] of Object.entries(nodes)) {
    validateWorkflowNodeShape(nodeId, node);
    validateWorkflowPassThroughShape(nodeId, node);
  }
}

export function hasWorkflowControlNodes(nodes: Record<string, WorkflowNodeConfig>): boolean {
  return Object.values(nodes).some((node) => node.control !== undefined);
}

export function getWorkflowExecutionOrder(nodes: Record<string, WorkflowNodeConfig>): string[] {
  const nodeIds = Object.keys(nodes);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) {
      return;
    }
    if (visiting.has(nodeId)) {
      throw new Error(`Workflow contains a dependency cycle at node "${nodeId}".`);
    }

    const node = nodes[nodeId];
    if (!node) {
      throw new Error(`Workflow references unknown node "${nodeId}".`);
    }

    visiting.add(nodeId);
    for (const dependency of getNodeNeeds(node)) {
      if (!nodes[dependency]) {
        throw new Error(`Workflow node "${nodeId}" needs unknown node "${dependency}".`);
      }
      visit(dependency);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    order.push(nodeId);
  }

  for (const nodeId of nodeIds) {
    visit(nodeId);
  }

  validateWorkflowNodeKinds(nodes);
  validateWorkflowControlTargets(nodes);

  const standaloneEndNodes = order.filter(
    (nodeId) => nodes[nodeId]?.control === 'end' && getNodeNeeds(nodes[nodeId] ?? {}).length === 0
  );
  const nonStandaloneEndNodes = order.filter((nodeId) => !standaloneEndNodes.includes(nodeId));
  const executionOrder = [...nonStandaloneEndNodes, ...standaloneEndNodes];
  validateWorkflowControlRouteDirection(nodes, executionOrder);
  return executionOrder;
}

export function getWorkflowNodes(
  workflowName: string,
  workflow: WorkflowConfig
): Record<string, WorkflowNodeConfig> {
  const nodes = workflow.nodes as unknown;
  if (
    typeof nodes !== 'object' ||
    nodes === null ||
    Array.isArray(nodes) ||
    Object.keys(nodes).length === 0
  ) {
    throw new Error(`Workflow "${workflowName}" must define at least one node.`);
  }

  return nodes as Record<string, WorkflowNodeConfig>;
}

export function getWorkflowExecutionWaves(
  nodes: Record<string, WorkflowNodeConfig>,
  executionOrder: string[]
): string[][] {
  const depthByNode = new Map<string, number>();
  const waves: string[][] = [];

  for (const nodeId of executionOrder) {
    const node = nodes[nodeId];
    if (!node) {
      throw new Error(`Workflow references unknown node "${nodeId}".`);
    }

    const depth = getNodeNeeds(node).reduce((maxDepth, dependency) => {
      return Math.max(maxDepth, (depthByNode.get(dependency) ?? 0) + 1);
    }, 0);

    depthByNode.set(nodeId, depth);
    waves[depth] = waves[depth] ?? [];
    waves[depth].push(nodeId);
  }

  return waves;
}

export function getPathValue(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (current === undefined || current === null) {
      return undefined;
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    return (current as Record<string, unknown>)[part];
  }, root);
}

export function stringifyTemplateValue(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

export function renderTemplate(template: string, context: WorkflowTemplateContext): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath: string) => {
    const path = rawPath.trim();
    const value = getPathValue(context, path);
    if (value === undefined) {
      throw new Error(`Unknown workflow template value "{{${path}}}".`);
    }
    return stringifyTemplateValue(value);
  });
}

export function getNodeKind(node: WorkflowNodeConfig): 'agent' | 'agents' | 'action' | 'control' {
  const configuredKinds = [node.agent, node.agentsFrom, node.action, node.control].filter(
    (value) => value !== undefined
  ).length;

  if (configuredKinds !== 1) {
    throw new Error(
      'Workflow node must define exactly one of agent, agentsFrom, action, or control.'
    );
  }

  if (node.agent !== undefined) return 'agent';
  if (node.agentsFrom !== undefined) return 'agents';
  if (node.control !== undefined) return 'control';
  return 'action';
}

export type WorkflowSegment =
  | { type: 'dag'; nodeIds: string[]; activeNodeIds?: Set<string> }
  | { type: 'control'; nodeId: string };

export function parseWorkflowExpressionValue(
  value: string,
  context?: WorkflowTemplateContext
): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const templateReference = trimmed.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (templateReference && context) {
    const path = templateReference[1]?.trim() ?? '';
    const resolved = getPathValue(context, path);
    if (resolved === undefined) {
      throw new Error(`Unknown workflow template value "{{${path}}}".`);
    }
    return resolved;
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1);
    return context ? renderTemplate(inner, context) : inner;
  }
  if (context && /^(inputs|nodes|artifacts|loop)\.[A-Za-z0-9_.-]+$/.test(trimmed)) {
    const resolved = getPathValue(context, trimmed);
    if (resolved === undefined) {
      throw new Error(`Unknown workflow expression value "${trimmed}".`);
    }
    return resolved;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

export function isWorkflowTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return (
      normalized.length > 0 && normalized !== 'false' && normalized !== '0' && normalized !== 'no'
    );
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

export function normalizeWorkflowBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

export function compareWorkflowValues(left: unknown, operator: string, right: unknown): boolean {
  if (operator === '==' || operator === '!=') {
    const leftBoolean = normalizeWorkflowBooleanLike(left);
    const rightBoolean = normalizeWorkflowBooleanLike(right);
    const matches =
      leftBoolean !== undefined || rightBoolean !== undefined
        ? leftBoolean === rightBoolean
        : String(left) === String(right);
    return operator === '==' ? matches : !matches;
  }

  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) {
    throw new Error(`Workflow expression operator "${operator}" requires numeric values.`);
  }

  if (operator === '>') return leftNumber > rightNumber;
  if (operator === '>=') return leftNumber >= rightNumber;
  if (operator === '<') return leftNumber < rightNumber;
  if (operator === '<=') return leftNumber <= rightNumber;
  throw new Error(`Unsupported workflow expression operator "${operator}".`);
}

export function splitWorkflowExpressionOperator(
  expression: string,
  operator: '&&' | '||'
): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let depth = 0;

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i] ?? '';
    if ((char === '"' || char === "'") && expression[i - 1] !== '\\') {
      quote = quote === char ? undefined : (quote ?? char);
      current += char;
      continue;
    }

    if (!quote && char === '(') {
      depth += 1;
      current += char;
      continue;
    }

    if (!quote && char === ')' && depth > 0) {
      depth -= 1;
      current += char;
      continue;
    }

    if (!quote && depth === 0 && expression.slice(i, i + operator.length) === operator) {
      parts.push(current.trim());
      current = '';
      i += operator.length - 1;
      continue;
    }

    current += char;
  }

  parts.push(current.trim());
  return parts;
}

export function stripWorkflowExpressionParens(expression: string): string {
  const trimmed = expression.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) {
    return trimmed;
  }

  let quote: '"' | "'" | undefined;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i] ?? '';
    if ((char === '"' || char === "'") && trimmed[i - 1] !== '\\') {
      quote = quote === char ? undefined : (quote ?? char);
      continue;
    }
    if (quote) continue;
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && i < trimmed.length - 1) {
      return trimmed;
    }
  }

  return trimmed.slice(1, -1).trim();
}

export function evaluateWorkflowExpressionText(
  rendered: string,
  context: WorkflowTemplateContext
): boolean {
  rendered = stripWorkflowExpressionParens(rendered);
  const orParts = splitWorkflowExpressionOperator(rendered, '||');
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateWorkflowExpressionText(part, context));
  }

  const andParts = splitWorkflowExpressionOperator(rendered, '&&');
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateWorkflowExpressionText(part, context));
  }

  const match = rendered.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!match) {
    return isWorkflowTruthy(parseWorkflowExpressionValue(rendered, context));
  }

  return compareWorkflowValues(
    parseWorkflowExpressionValue(match[1] ?? '', context),
    match[2] ?? '',
    parseWorkflowExpressionValue(match[3] ?? '', context)
  );
}

export function evaluateWorkflowExpression(
  expression: string,
  context: WorkflowTemplateContext
): boolean {
  return evaluateWorkflowExpressionText(expression.trim(), context);
}

export function splitWorkflowSegments(
  workflowNodes: Record<string, WorkflowNodeConfig>,
  executionOrder: string[]
): WorkflowSegment[] {
  const segments: WorkflowSegment[] = [];
  let currentDag: string[] = [];

  for (const nodeId of executionOrder) {
    const node = workflowNodes[nodeId];
    if (!node) {
      throw new Error(`Workflow references unknown node "${nodeId}".`);
    }

    if (node.control !== undefined) {
      if (currentDag.length > 0) {
        segments.push({ type: 'dag', nodeIds: currentDag });
        currentDag = [];
      }
      segments.push({ type: 'control', nodeId });
    } else {
      currentDag.push(nodeId);
    }
  }

  if (currentDag.length > 0) {
    segments.push({ type: 'dag', nodeIds: currentDag });
  }

  return segments;
}

export function findWorkflowSegmentIndex(
  segments: WorkflowSegment[],
  targetNodeId: string
): number {
  return segments.findIndex((segment) =>
    segment.type === 'control'
      ? segment.nodeId === targetNodeId
      : segment.nodeIds.includes(targetNodeId)
  );
}

export function computeActiveWorkflowNodes(
  workflowNodes: Record<string, WorkflowNodeConfig>,
  nodeIds: string[],
  rootNodeId: string,
  includeRootDependencies = true
): Set<string> {
  const segmentNodeIds = new Set(nodeIds);
  const downstream = new Set<string>([rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const nodeId of nodeIds) {
      if (downstream.has(nodeId)) continue;
      const needs = getNodeNeeds(workflowNodes[nodeId] ?? {});
      if (needs.some((dependency) => downstream.has(dependency))) {
        downstream.add(nodeId);
        changed = true;
      }
    }
  }

  const active = new Set(downstream);
  const includeDependencies = (nodeId: string) => {
    const node = workflowNodes[nodeId];
    if (!node) return;
    for (const dependency of getNodeNeeds(node)) {
      if (!segmentNodeIds.has(dependency) || active.has(dependency)) continue;
      active.add(dependency);
      includeDependencies(dependency);
    }
  };

  if (includeRootDependencies) {
    for (const nodeId of downstream) {
      includeDependencies(nodeId);
    }
  }

  return active;
}

export function runControlWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext
): { result: WorkflowNodeResult; nextNodeId?: string; ended?: boolean } {
  if (node.control === 'loop') {
    const expression = node.if;
    if (!expression) {
      throw new Error(`Workflow loop node "${nodeId}" must define if.`);
    }
    if (!node.target || !node.exit) {
      throw new Error(`Workflow loop node "${nodeId}" must define target and exit.`);
    }
    const rawMaxIterations: string | number | undefined = node.maxIterations;
    const renderedMaxIterations =
      typeof rawMaxIterations === 'string'
        ? renderTemplate(rawMaxIterations, context).trim()
        : String(rawMaxIterations ?? '');
    const configuredMaxIterations = Number.parseInt(renderedMaxIterations, 10);
    if (
      renderedMaxIterations === '' ||
      !Number.isInteger(configuredMaxIterations) ||
      configuredMaxIterations <= 0
    ) {
      throw new Error(`Workflow loop node "${nodeId}" must define a positive maxIterations.`);
    }
    const maxIterations = configuredMaxIterations;

    const shouldLoop = evaluateWorkflowExpression(expression, context);
    const current = context.loop[nodeId] ?? { iteration: 1, maxIterations };
    let nextNodeId = node.exit;
    let decision: 'loop' | 'exit' = 'exit';

    if (shouldLoop) {
      if (current.iteration >= maxIterations) {
        if (node.onMaxIterations === 'exit') {
          nextNodeId = node.exit;
        } else {
          throw new Error(
            `Workflow loop node "${nodeId}" reached maxIterations (${maxIterations}).`
          );
        }
      } else {
        decision = 'loop';
        nextNodeId = node.target;
        current.iteration += 1;
      }
    }

    current.maxIterations = maxIterations;
    current.lastDecision = decision;
    context.loop[nodeId] = current;

    return {
      nextNodeId,
      result: {
        id: nodeId,
        type: 'control',
        status: 'success',
        control: node.control,
        decision,
        target: nextNodeId,
        response: decision,
        output: {
          matched: shouldLoop,
          target: nextNodeId,
          iteration: current.iteration,
          maxIterations,
        },
      },
    };
  }

  if (node.control === 'switch') {
    if (!node.value || !node.cases) {
      throw new Error(`Workflow switch node "${nodeId}" must define value and cases.`);
    }
    const value = renderTemplate(node.value, context).trim();
    const nextNodeId = node.cases[value] ?? node.default;
    if (!nextNodeId) {
      throw new Error(`Workflow switch node "${nodeId}" has no case for "${value}" or default.`);
    }
    return {
      nextNodeId,
      result: {
        id: nodeId,
        type: 'control',
        status: 'success',
        control: node.control,
        decision: value,
        target: nextNodeId,
        response: value,
        output: { value, target: nextNodeId },
      },
    };
  }

  if (node.control === 'end') {
    return {
      ended: true,
      result: {
        id: nodeId,
        type: 'control',
        status: 'success',
        control: node.control,
        decision: 'end',
        response: 'end',
        output: { ended: true },
      },
    };
  }

  if (node.control === 'passThrough') {
    const result: WorkflowNodeResult = {
      id: nodeId,
      type: 'control',
      control: 'passThrough',
      target: node.target,
      decision: 'pass',
      response: `passed through to ${node.target}`,
    };
    return { result, nextNodeId: node.target };
  }

  throw new Error(`Unsupported workflow control "${node.control}" in node "${nodeId}".`);
}

export function createSkippedWorkflowNodeResult(nodeId: string): WorkflowNodeResult {
  const timestamp = new Date().toISOString();
  return {
    id: nodeId,
    type: 'skipped',
    status: 'skipped',
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    response: '',
    output: undefined,
  };
}

export function getWorkflowNodeRunCondition(node: WorkflowNodeConfig): string | undefined {
  return node.if;
}

export function getSkippedWorkflowDependencies(
  node: WorkflowNodeConfig,
  nodes: Record<string, WorkflowNodeResult>
): string[] {
  return getNodeNeeds(node).filter((dependency) => nodes[dependency]?.status === 'skipped');
}

export function getWorkflowNodeSkipReason(
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext
): string | undefined {
  const skippedDependencies = getSkippedWorkflowDependencies(node, context.nodes);
  if (skippedDependencies.length > 0) {
    return `dependency skipped: ${skippedDependencies.join(', ')}`;
  }

  const ifExpression = getWorkflowNodeRunCondition(node);
  if (ifExpression !== undefined && !evaluateWorkflowExpression(ifExpression, context)) {
    return `if false: ${ifExpression}`;
  }

  return undefined;
}
