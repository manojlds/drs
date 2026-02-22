export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

export function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}
