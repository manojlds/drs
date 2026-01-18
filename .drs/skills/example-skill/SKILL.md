# Example Skill

This is an example skill that demonstrates how to create skills for DRS code reviews.

## Instructions

When reviewing code, consider the following:

### Code Quality

1. **Readability**: Code should be self-documenting where possible
2. **Maintainability**: Avoid overly complex solutions
3. **Testability**: Write code that's easy to test

### Project Standards

- Use TypeScript strict mode
- Follow ESLint configuration
- Include JSDoc comments for public APIs
- Write unit tests for business logic

### Best Practices

- Keep functions small and focused (single responsibility)
- Use meaningful variable and function names
- Handle errors appropriately
- Avoid premature optimization

## Examples

### Good Example

```typescript
/**
 * Validates user email address
 * @param email - Email address to validate
 * @returns true if valid, false otherwise
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
```

### Bad Example

```typescript
// Avoid single-letter variables and unclear logic
function v(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
```

## References

- [Clean Code Principles](https://github.com/ryanmcdermott/clean-code-javascript)
- [TypeScript Best Practices](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html)
