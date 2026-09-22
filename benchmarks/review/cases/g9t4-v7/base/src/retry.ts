const RETRYABLE_DELIVERY_CODES = new Set([7400, 7407]);

export function shouldRetryDelivery(code: number): boolean {
  return RETRYABLE_DELIVERY_CODES.has(code);
}
