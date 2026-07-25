export function parse(value: string): number {
  if (value.trim() === '') throw new Error('empty');
  return Number(value);
}
