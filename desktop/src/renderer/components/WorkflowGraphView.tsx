import { useMemo, useState } from 'react';
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
  WorkflowRunNodeResult,
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const runtime = useMemo(
    () => buildWorkflowRuntime(graph, result, activeLogs, active, error),
    [active, activeLogs, error, graph, result]
  );
  const { nodes, edges } = useMemo(() => layoutWorkflowGraph(graph, runtime), [graph, runtime]);

  if (!graph || graph.nodes.length === 0) {
    return <div className="workflow-graph-empty">No workflow graph available.</div>;
  }

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedRuntime = selectedNode ? runtime.get(selectedNode.id) : undefined;
  const selectedResult = selectedNode ? result?.nodes[selectedNode.id] : undefined;

  return (
    <div className="workflow-graph-view">
      <div className="workflow-graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesDraggable={false}
          onNodeClick={(_, node) => setSelectedNodeId(node.id)}
        >
          <Background gap={18} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <WorkflowNodeInspector node={selectedNode} runtime={selectedRuntime} result={selectedResult} />
    </div>
  );
}

type WorkflowNodeRuntimeStatus = 'pending' | 'running' | 'success' | 'skipped' | 'failed';

interface WorkflowNodeRuntime {
  status: WorkflowNodeRuntimeStatus;
  writes?: string;
  hasOutput?: boolean;
  durationMs?: number;
  cost?: number;
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
        durationMs: nodeResult.durationMs,
        cost: getWorkflowNodeCost(nodeResult),
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

function getWorkflowNodeCost(result: WorkflowRunNodeResult): number | undefined {
  if (Array.isArray(result.responses)) {
    const total = result.responses.reduce((sum, response) => sum + (response.usage?.usage?.cost ?? 0), 0);
    return total > 0 ? total : undefined;
  }

  const outputCost = getUnknownUsageCost(result.output);
  if (outputCost !== undefined) return outputCost;

  const outputsCost = getUnknownUsageCost(result.outputs);
  return outputsCost;
}

function getUnknownUsageCost(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as {
    usage?: { total?: { cost?: unknown }; usage?: { cost?: unknown }; cost?: unknown };
    total?: { cost?: unknown };
  };
  const rawCost =
    candidate.usage?.total?.cost ?? candidate.usage?.usage?.cost ?? candidate.usage?.cost ?? candidate.total?.cost;
  return typeof rawCost === 'number' && rawCost > 0 ? rawCost : undefined;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function stringifyPreview(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
      {runtime?.durationMs !== undefined && <small>duration: {formatDuration(runtime.durationMs)}</small>}
      {runtime?.cost !== undefined && <small>cost: {formatCost(runtime.cost)}</small>}
      {runtime?.writes && <small>writes: {runtime.writes}</small>}
      {runtime?.hasOutput && <small>artifact/output available</small>}
    </div>
  );
}

function WorkflowNodeInspector({
  node,
  runtime,
  result,
}: {
  node: WorkflowGraphNode | null;
  runtime?: WorkflowNodeRuntime;
  result?: WorkflowRunNodeResult;
}) {
  if (!node) {
    return <div className="workflow-node-inspector empty">Select a graph node to inspect runtime details.</div>;
  }

  const outputPreview = stringifyPreview(result?.output ?? result?.outputs ?? result?.response);

  return (
    <div className="workflow-node-inspector">
      <div className="workflow-node-inspector-head">
        <div>
          <span>Selected Node</span>
          <strong>{node.id}</strong>
        </div>
        <b className={`workflow-node-status ${runtime?.status ?? 'pending'}`}>{runtime?.status ?? 'pending'}</b>
      </div>
      <dl>
        <div><dt>Kind</dt><dd>{node.kind}</dd></div>
        <div><dt>Handler</dt><dd>{node.agent ?? node.agentsFrom ?? node.action ?? node.control ?? 'n/a'}</dd></div>
        {node.condition && <div><dt>Condition</dt><dd>{node.condition}</dd></div>}
        {runtime?.durationMs !== undefined && <div><dt>Duration</dt><dd>{formatDuration(runtime.durationMs)}</dd></div>}
        {runtime?.cost !== undefined && <div><dt>Cost</dt><dd>{formatCost(runtime.cost)}</dd></div>}
        {runtime?.writes && <div><dt>Writes</dt><dd>{runtime.writes}</dd></div>}
        {result?.startedAt && <div><dt>Started</dt><dd>{new Date(result.startedAt).toLocaleTimeString()}</dd></div>}
      </dl>
      {outputPreview && <pre>{outputPreview.slice(0, 2000)}</pre>}
    </div>
  );
}
