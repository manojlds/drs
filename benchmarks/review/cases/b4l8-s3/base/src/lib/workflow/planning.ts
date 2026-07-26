type Node = { needs?: string[] };

export function computeLoopNodes(
  nodes: Record<string, Node>,
  target: string,
  downstream: string[],
  isLoopBackEdge: boolean
): Set<string> {
  const active = new Set([target, ...downstream]);
  if (!isLoopBackEdge) {
    for (const id of [...active]) {
      for (const dependency of nodes[id]?.needs ?? []) active.add(dependency);
    }
  }
  return active;
}

export function activateAfterControl(
  nodes: Record<string, Node>,
  target: string,
  downstream: string[],
  control: 'loop' | 'switch'
): Set<string> {
  return computeLoopNodes(nodes, target, downstream, control === 'loop');
}
