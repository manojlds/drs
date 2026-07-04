import type { WorkflowConfig, WorkflowNodeConfig } from '../config.js';
import {
  getNodeKind,
  getNodeNeeds,
  getWorkflowExecutionOrder,
  getWorkflowNodes,
} from './planning.js';

export type WorkflowGraphNodeKind = 'agent' | 'agents' | 'action' | 'control';
export type WorkflowGraphEdgeKind = 'dependency' | 'control';

export interface WorkflowGraphNode {
  id: string;
  label: string;
  kind: WorkflowGraphNodeKind;
  agent?: string;
  agentsFrom?: string;
  action?: string;
  control?: string;
  condition?: string;
  output?: string;
  writes?: string;
}

export interface WorkflowGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: WorkflowGraphEdgeKind;
  label?: string;
}

export interface WorkflowGraph {
  workflow: string;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

export function buildWorkflowGraph(workflowName: string, workflow: WorkflowConfig): WorkflowGraph {
  const nodesById = getWorkflowNodes(workflowName, workflow);
  const orderedNodeIds = getWorkflowExecutionOrder(nodesById);
  const edges: WorkflowGraphEdge[] = [];

  for (const nodeId of orderedNodeIds) {
    const node = nodesById[nodeId];
    if (!node) continue;

    for (const dependency of getNodeNeeds(node)) {
      edges.push({
        id: `dependency:${dependency}->${nodeId}`,
        source: dependency,
        target: nodeId,
        kind: 'dependency',
      });
    }

    edges.push(...getWorkflowControlEdges(nodeId, node));
  }

  return {
    workflow: workflowName,
    nodes: orderedNodeIds.map((nodeId) => buildWorkflowGraphNode(nodeId, nodesById[nodeId])),
    edges,
  };
}

export function formatWorkflowGraphMermaid(graph: WorkflowGraph): string {
  const lines = ['flowchart TD'];

  for (const node of graph.nodes) {
    lines.push(`  ${mermaidId(node.id)}${mermaidNodeShape(node)}`);
  }

  for (const edge of graph.edges) {
    const label = edge.label ? `|${escapeMermaidLabel(edge.label)}|` : '';
    const arrow = edge.kind === 'control' ? '-.->' : '-->';
    lines.push(`  ${mermaidId(edge.source)} ${arrow}${label} ${mermaidId(edge.target)}`);
  }

  return `${lines.join('\n')}\n`;
}

function buildWorkflowGraphNode(nodeId: string, node: WorkflowNodeConfig): WorkflowGraphNode {
  return {
    id: nodeId,
    label: getWorkflowGraphNodeLabel(nodeId, node),
    kind: getNodeKind(node),
    agent: node.agent,
    agentsFrom: node.agentsFrom,
    action: node.action,
    control: node.control,
    condition: node.if,
    output: node.output,
    writes: node.writes,
  };
}

function getWorkflowGraphNodeLabel(nodeId: string, node: WorkflowNodeConfig): string {
  if (node.agent) return `${nodeId}\n${node.agent}`;
  if (node.agentsFrom) return `${nodeId}\n${node.agentsFrom}`;
  if (node.action) return `${nodeId}\n${node.action}`;
  if (node.control) return `${nodeId}\n${node.control}`;
  return nodeId;
}

function getWorkflowControlEdges(nodeId: string, node: WorkflowNodeConfig): WorkflowGraphEdge[] {
  if (node.control === 'loop') {
    return [
      ...(node.target
        ? [
            {
              id: `control:${nodeId}->${node.target}:loop`,
              source: nodeId,
              target: node.target,
              kind: 'control' as const,
              label: node.if ? `loop: ${node.if}` : 'loop',
            },
          ]
        : []),
      ...(node.exit
        ? [
            {
              id: `control:${nodeId}->${node.exit}:exit`,
              source: nodeId,
              target: node.exit,
              kind: 'control' as const,
              label: 'exit',
            },
          ]
        : []),
    ];
  }

  if (node.control === 'switch') {
    return [
      ...Object.entries(node.cases ?? {}).map(([caseLabel, target]) => ({
        id: `control:${nodeId}->${target}:case:${caseLabel}`,
        source: nodeId,
        target,
        kind: 'control' as const,
        label: `case ${caseLabel}`,
      })),
      ...(node.default
        ? [
            {
              id: `control:${nodeId}->${node.default}:default`,
              source: nodeId,
              target: node.default,
              kind: 'control' as const,
              label: 'default',
            },
          ]
        : []),
    ];
  }

  if (node.control === 'passThrough' && node.target) {
    return [
      {
        id: `control:${nodeId}->${node.target}:target`,
        source: nodeId,
        target: node.target,
        kind: 'control',
        label: 'target',
      },
    ];
  }

  return [];
}

function mermaidId(id: string): string {
  return `n_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function mermaidNodeShape(node: WorkflowGraphNode): string {
  const label = escapeMermaidLabel(node.label);
  if (node.kind === 'control') return `{${label}}`;
  if (node.kind === 'agent' || node.kind === 'agents') return `([${label}])`;
  return `[${label}]`;
}

function escapeMermaidLabel(label: string): string {
  return JSON.stringify(label).slice(1, -1).replace(/"/g, '#quot;');
}
