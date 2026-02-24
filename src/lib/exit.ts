/**
 * Process exit abstraction for testability.
 *
 * Library code should call `exitProcess(code)` instead of `process.exit(code)`.
 * In tests the handler can be replaced with `setExitHandler()` to capture
 * the exit code without terminating the process.
 */

export type ExitHandler = (code: number) => never;

let currentHandler: ExitHandler = ((code: number) => {
  process.exit(code);
}) as ExitHandler;

/**
 * Exit the process (or trigger the installed handler in tests).
 */
export function exitProcess(code: number): never {
  return currentHandler(code);
}

/**
 * Replace the exit handler. Returns a restore function.
 *
 * ```ts
 * const restore = setExitHandler((code) => { throw new ExitError(code); });
 * try { ... } finally { restore(); }
 * ```
 */
export function setExitHandler(handler: ExitHandler): () => void {
  const previous = currentHandler;
  currentHandler = handler;
  return () => {
    currentHandler = previous;
  };
}

/**
 * Error thrown by the test exit handler so callers can
 * assert on the exit code.
 */
export class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
    this.name = 'ExitError';
  }
}

/**
 * Install a test exit handler that throws `ExitError`.
 * Returns a restore function.
 */
export function installTestExitHandler(): () => void {
  return setExitHandler(((code: number) => {
    throw new ExitError(code);
  }) as ExitHandler);
}
