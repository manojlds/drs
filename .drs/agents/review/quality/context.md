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
- Functions exceeding 200 lines (suggest extraction)
- Missing error handling for async operations **that don't have fallback behavior**
- Unhandled promise rejections **without try-catch or .catch()**
- Deep nesting (> 4 levels)
- **Significant** code duplication (>30 lines duplicated across multiple files)
- Unclear variable names (e.g., `x`, `tmp`, `data` without context)

#### Medium Priority
- **Magic numbers that should be named constants** (timeouts, retry counts, buffer sizes, etc.)
- Functions 100-200 lines that could benefit from extraction
- Complex boolean conditions that could be simplified
- Missing null/undefined checks where needed
- **Public API functions** without JSDoc comments

#### Low Priority
- Minor style inconsistencies
- Optional type annotations
- Verbose but clear code
- Missing JSDoc on **internal/private** helper functions
- Small code duplication (< 30 lines) where abstraction might be over-engineering

### What NOT to Flag

#### Acceptable Patterns
- ✅ Using `console.log` and `console.error` - This is a CLI tool, terminal output is expected
- ✅ `process.exit()` - Appropriate for CLI tools to signal success/failure
- ✅ Inline arrow functions for simple operations (map, filter, etc.)
- ✅ Some code duplication when abstraction would be over-engineering
- ✅ **Promise.all() when individual promises have error handling** - If each promise in the array has try-catch and returns a safe fallback value (e.g., empty array), the Promise.all is safe
- ✅ **Type assertions to 'any' for API/framework compatibility** - When working around TypeScript limitations for external API types, partial config merging, or library compatibility, casting to 'any' is acceptable if the runtime behavior is safe
- ✅ **Graceful degradation with logging** - Catch blocks that log warnings/errors and provide fallback behavior (e.g., catch + console.warn + alternative action) are proper error handling, not "silent failures"
- ✅ **Small code duplication (< 30 lines)** - Don't flag duplicated blocks of < 30 lines when the contexts differ or abstraction would add more complexity than it removes
- ✅ **Standard JavaScript patterns** - `while ((match = regex.exec(str)) !== null)` is the correct way to iterate regex matches with /g flag; don't flag as "inefficient"
- ✅ **Missing JSDoc on internal/private functions** - Only flag missing documentation on public APIs, exported functions, or complex algorithms; internal helper functions don't need JSDoc

## Severity Calibration

### CRITICAL
- Code that will definitely fail at runtime
- Infinite loops or recursion without base case
- Example: Accessing undefined properties without checking

### HIGH
- Missing error handling that could crash the application **without recovery**
- Unhandled promise rejections **without try-catch or .catch() handlers**
- Significant code duplication (>30 lines of identical logic copy-pasted)
- Functions >200 lines that should be refactored
- **Note**: Do NOT flag Promise.all() if individual promises handle their own errors
- **Note**: Do NOT flag catch blocks that use graceful degradation (log + fallback)

### MEDIUM
- Functions 100-200 lines (suggest refactoring if they're hard to understand)
- Magic numbers that should be named constants (timeouts, limits, sizes)
- Moderate code duplication (20-30 lines in 2-3 places where abstraction is clear)
- Missing type annotations where type safety matters
- **Note**: Do NOT flag type assertions to 'any' when used for API/library compatibility
- **Note**: Do NOT flag small code duplication if abstraction would add complexity

### LOW
- Missing JSDoc comments **on public APIs only** (not internal helpers)
- Minor refactoring opportunities that don't impact maintainability
- Verbose but functional code
- Small code duplication (< 20 lines)
- Example: Could use array method instead of for loop (but for loop is clearer)
