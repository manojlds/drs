export function encodeKey(tenantId: string, operation: string, revision: number): string {
  return `${tenantId}:${operation}:${revision}`;
}
