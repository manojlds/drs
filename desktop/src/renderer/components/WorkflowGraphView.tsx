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
import type {
  WorkflowGraph,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowRunResultJson,
} from '../../shared/ipc-types';

interface WorkflowGraphViewProps {
  graph: WorkflowGraph | null | undefined;
  result?: WorkflowRunResultJson | null;
  activeLogs?: string[];
  active?: boolean;
  error?: string | null;
}

export function WorkflowGraphView({ graph, result, activeLogs = [], active = false, error = null }: WorkflowGraphViewProps) {
  const runtime = useMemo(
    () => buildWorkflowRuntime(graph, result, activeLogs, active, error),
    [active, activeLogs, error, graph, result]
  );
  const { nodes, edges } = useMemo(() => layoutWorkflowGraph(graph, runtime), [graph, runtime]);

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

type WorkflowNodeRuntimeStatus = 'pending' | 'running' | 'success' | 'skipped' | 'failed';

interface WorkflowNodeRuntime {
  status: WorkflowNodeRuntimeStatus;
  writes?: string;
  hasOutput?: boolean;
}

function layoutWorkflowGraph(
  graph: WorkflowGraph | null | undefined,
  runtime: Map<string, WorkflowNodeRuntime>
): { nodes: Node[]; edges: Edge[] } {
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
        data: { label: <WorkflowNodeLabel node={node} runtime={runtime.get(node.id)} /> },
        className: `workflow-flow-node ${node.kind} ${runtime.get(node.id)?.status ?? 'pending'}`,
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
      className: `workflow-flow-edge ${edge.kind} ${runtime.get(edge.target)?.status ?? 'pending'}`,
    })),
  };
}

function buildWorkflowRuntime(
  graph: WorkflowGraph | null | undefined,
  result: WorkflowRunResultJson | null | undefined,
  activeLogs: string[],
  active: boolean,
  error: string | null
): Map<string, WorkflowNodeRuntime> {
  const runtime = new Map<string, WorkflowNodeRuntime>();
  if (!graph) return runtime;

  for (const node of graph.nodes) {
    runtime.set(node.id, { status: active ? 'pending' : 'pending' });
  }

  if (result?.workflow === graph.workflow) {
    for (const [nodeId, nodeResult] of Object.entries(result.nodes)) {
      runtime.set(nodeId, {
        status: nodeResult.status === 'skipped' ? 'skipped' : 'success',
        writes: nodeResult.writes,
        hasOutput: nodeResult.output !== undefined || !!nodeResult.outputs,
      });
    }
  }

  if (!active && !error) return runtime;

  const runningNodes = new Set<string>();
  const skippedNodes = new Set<string>();
  for (const log of activeLogs) {
    const runningMatch = log.match(/Running node ([A-Za-z0-9_.-]+)\.\.\./);
    if (runningMatch?.[1]) runningNodes.add(runningMatch[1]);
    const skippedMatch = log.match(/Skipping node ([A-Za-z0-9_.-]+) /);
    if (skippedMatch?.[1]) skippedNodes.add(skippedMatch[1]);
  }

  for (const nodeId of skippedNodes) {
    runtime.set(nodeId, { ...runtime.get(nodeId), status: 'skipped' });
  }
  for (const nodeId of runningNodes) {
    const current = runtime.get(nodeId);
    if (current?.status !== 'success' && current?.status !== 'skipped') {
      runtime.set(nodeId, { ...current, status: 'running' });
    }
  }

  if (error) {
    const lastRunningNode = Array.from(runningNodes).at(-1);
    if (lastRunningNode) {
      runtime.set(lastRunningNode, { ...runtime.get(lastRunningNode), status: 'failed' });
    }
  }

  return runtime;
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

function WorkflowNodeLabel({ node, runtime }: { node: WorkflowGraphNode; runtime?: WorkflowNodeRuntime }) {
  const subtitle = node.agent ?? node.agentsFrom ?? node.action ?? node.control ?? node.kind;
  return (
    <div className="workflow-node-label">
      <div className="workflow-node-title-row">
        <strong>{node.id}</strong>
        <b className={`workflow-node-status ${runtime?.status ?? 'pending'}`}>{runtime?.status ?? 'pending'}</b>
      </div>
      <span>{subtitle}</span>
      {node.condition && <em>if {node.condition}</em>}
      {node.output && <small>output: {node.output}</small>}
      {runtime?.writes && <small>writes: {runtime.writes}</small>}
      {runtime?.hasOutput && <small>artifact/output available</small>}
    </div>
  );
}
