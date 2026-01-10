# Quality Agent Context for DRS

## Project-Specific Quality Guidelines

### Code Quality Focus Areas
- Error handling and graceful degradation
- Type safety (minimize `any` types, use proper TypeScript types)
- Function length and complexity
- Code duplication and reusability
- Clear variable and function naming

### What to Prioritize

#### High Priority
- Functions exceeding 100 lines (suggest extraction)
- Missing error handling for async operations
- Deep nesting (> 3 levels)
- Code duplication across multiple files
- Unclear variable names (e.g., `x`, `tmp`, `data` without context)

#### Medium Priority
- Functions without JSDoc comments
- Magic numbers that should be constants
- Complex boolean conditions that could be simplified
- Missing null/undefined checks where needed

#### Low Priority
- Minor style inconsistencies
- Optional type annotations
- Verbose but clear code

### What NOT to Flag

#### Acceptable Patterns
- ✅ Using `console.log` and `console.error` - This is a CLI tool, terminal output is expected
- ✅ `process.exit()` - Appropriate for CLI tools to signal success/failure
- ✅ Inline arrow functions for simple operations (map, filter, etc.)
- ✅ Some code duplication when abstraction would be over-engineering

## Severity Calibration

### CRITICAL
- Code that will definitely fail at runtime
- Infinite loops or recursion without base case
- Example: Accessing undefined properties without checking

### HIGH
- Missing error handling that could crash the application
- Significant code duplication (copy-pasted logic)
- Functions >200 lines that should be refactored
- Example: Unhandled promise rejections

### MEDIUM
- Functions 100-200 lines (suggest refactoring)
- Missing type annotations where type safety matters
- Moderate code duplication
- Example: Repeated similar logic in 2-3 places

### LOW
- Missing JSDoc comments
- Minor refactoring opportunities
- Verbose but functional code
- Example: Could use array method instead of for loop
