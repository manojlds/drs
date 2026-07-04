import { useMemo } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode } from '../../shared/ipc-types';

interface WorkflowGraphViewProps {
  graph: WorkflowGraph | null | undefined;
}

export function WorkflowGraphView({ graph }: WorkflowGraphViewProps) {
  const { nodes, edges } = useMemo(() => layoutWorkflowGraph(graph), [graph]);

  if (!graph || graph.nodes.length === 0) {
    return <div className="workflow-graph-empty">No workflow graph available.</div>;
  }

  return (
    <div className="workflow-graph-view">
      <ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false}>
        <Background gap={18} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}

function layoutWorkflowGraph(graph: WorkflowGraph | null | undefined): { nodes: Node[]; edges: Edge[] } {
  if (!graph) return { nodes: [], edges: [] };

  const levels = computeNodeLevels(graph.nodes, graph.edges);
  const rowsByLevel = new Map<number, WorkflowGraphNode[]>();
  for (const node of graph.nodes) {
    const level = levels.get(node.id) ?? 0;
    rowsByLevel.set(level, [...(rowsByLevel.get(level) ?? []), node]);
  }

  const nodes: Node[] = [];
  for (const [level, levelNodes] of rowsByLevel) {
    levelNodes.forEach((node, row) => {
      nodes.push({
        id: node.id,
        type: 'default',
        position: { x: level * 280, y: row * 120 },
        data: { label: <WorkflowNodeLabel node={node} /> },
        className: `workflow-flow-node ${node.kind}`,
      });
    });
  }

  return {
    nodes,
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      animated: edge.kind === 'control',
      type: 'smoothstep',
      className: `workflow-flow-edge ${edge.kind}`,
    })),
  };
}

function computeNodeLevels(nodes: WorkflowGraphNode[], edges: WorkflowGraphEdge[]): Map<string, number> {
  const levels = new Map<string, number>();
  const nodeIds = new Set(nodes.map((node) => node.id));
  const order = new Map(nodes.map((node, index) => [node.id, index]));

  for (const node of nodes) levels.set(node.id, 0);

  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const edge of edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      if ((order.get(edge.target) ?? 0) <= (order.get(edge.source) ?? 0)) continue;
      const nextLevel = (levels.get(edge.source) ?? 0) + 1;
      if (nextLevel > (levels.get(edge.target) ?? 0)) {
        levels.set(edge.target, nextLevel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return levels;
}

function WorkflowNodeLabel({ node }: { node: WorkflowGraphNode }) {
  const subtitle = node.agent ?? node.agentsFrom ?? node.action ?? node.control ?? node.kind;
  return (
    <div className="workflow-node-label">
      <strong>{node.id}</strong>
      <span>{subtitle}</span>
      {node.condition && <em>if {node.condition}</em>}
      {node.output && <small>output: {node.output}</small>}
    </div>
  );
}
