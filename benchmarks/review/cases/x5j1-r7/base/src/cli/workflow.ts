type Node = { action: string };
type Context = { values: Record<string, unknown> };

async function runAction(node: Node, context: Context): Promise<unknown> {
  return { action: node.action, values: context.values };
}

async function runNode(node: Node, context: Context): Promise<unknown> {
  return runAction(node, context);
}
