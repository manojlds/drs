export function calculateCharge(units: number, rate: number, taxRate: number, adjustment: number): number {
  const subtotal = units * rate;
  return subtotal * (1 + taxRate) - adjustment;
}
