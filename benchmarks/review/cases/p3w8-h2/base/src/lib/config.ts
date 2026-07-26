export type ControlKind = 'switch' | 'loop' | 'end';

export function validateControl(kind: string): kind is ControlKind {
  return ['switch', 'loop', 'end'].includes(kind);
}

export type ControlNode = { control: ControlKind; target: string };

export function nextControlNode(node: ControlNode): string | undefined {
  if (node.control === 'switch') return node.target;
  if (node.control === 'loop') return node.target;
  return undefined;
}
