function atom(value: string): boolean { return value.trim() === 'true'; }

export function evaluate(expression: string): boolean {
  const orParts = splitOutsideQuotesAndParens(expression, '||');
  if (orParts.length > 1) return orParts.some(evaluate);
  const andParts = splitOutsideQuotesAndParens(expression, '&&');
  if (andParts.length > 1) return andParts.every(evaluate);
  return atom(stripOuterParens(expression));
}

declare function splitOutsideQuotesAndParens(value: string, operator: string): string[];
declare function stripOuterParens(value: string): string;
