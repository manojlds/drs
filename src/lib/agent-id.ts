export interface ParsedAgentId {
  id: string;
  namespace: string;
  name: string;
}

export function getAgentIdValidationError(agentId: string): string | null {
  if (agentId.length === 0 || agentId.trim() !== agentId) {
    return `Invalid agent id "${agentId}". Agent ids cannot be empty or contain surrounding whitespace.`;
  }

  if (agentId.includes('\0') || agentId.includes('\\')) {
    return `Invalid agent id "${agentId}". Agent ids must use "/" as the namespace separator and cannot contain null bytes.`;
  }

  const parts = agentId.split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    const suggestion = !agentId.includes('/') ? ` For review agents, use "review/${agentId}".` : '';
    return `Invalid agent id "${agentId}". Agents must be fully qualified as "<namespace>/<name>".${suggestion}`;
  }

  if (parts.some((part) => part === '.' || part === '..')) {
    return `Invalid agent id "${agentId}". "." and ".." path components are not allowed.`;
  }

  return null;
}

export function parseAgentId(agentId: string): ParsedAgentId | null {
  if (getAgentIdValidationError(agentId)) {
    return null;
  }

  const [namespace, name] = agentId.split('/');
  return { id: agentId, namespace, name };
}

export function requireAgentId(agentId: string): ParsedAgentId {
  const parsed = parseAgentId(agentId);
  if (!parsed) {
    throw new Error(getAgentIdValidationError(agentId) ?? `Invalid agent id "${agentId}".`);
  }

  return parsed;
}
