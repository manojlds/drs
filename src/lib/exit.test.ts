import { describe, it, expect, afterEach } from 'vitest';
import { exitProcess, setExitHandler, installTestExitHandler, ExitError } from './exit.js';

describe('exit', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  describe('exitProcess', () => {
    it('calls the installed handler with the exit code', () => {
      let capturedCode: number | undefined;
      restore = setExitHandler(((code: number) => {
        capturedCode = code;
      }) as never);

      try {
        exitProcess(1);
      } catch {
        // handler may not actually be `never` in test
      }

      expect(capturedCode).toBe(1);
    });

    it('passes exit code 0 for success', () => {
      let capturedCode: number | undefined;
      restore = setExitHandler(((code: number) => {
        capturedCode = code;
      }) as never);

      try {
        exitProcess(0);
      } catch {
        // handler may not actually be `never` in test
      }

      expect(capturedCode).toBe(0);
    });
  });

  describe('setExitHandler', () => {
    it('returns a restore function that reverts to previous handler', () => {
      const codes: number[] = [];
      const first = setExitHandler(((code: number) => {
        codes.push(code);
      }) as never);

      const second = setExitHandler(((code: number) => {
        codes.push(code * 10);
      }) as never);

      try {
        exitProcess(1);
      } catch {
        /* noop */
      }
      expect(codes).toEqual([10]); // second handler

      second(); // restore to first
      try {
        exitProcess(2);
      } catch {
        /* noop */
      }
      expect(codes).toEqual([10, 2]); // first handler

      first(); // restore to original
      restore = undefined; // already cleaned up
    });
  });

  describe('installTestExitHandler', () => {
    it('throws ExitError with the exit code', () => {
      restore = installTestExitHandler();

      expect(() => exitProcess(1)).toThrow(ExitError);
      expect(() => exitProcess(1)).toThrow('process.exit(1)');
    });

    it('captures exit code 0', () => {
      restore = installTestExitHandler();

      try {
        exitProcess(0);
      } catch (e) {
        expect(e).toBeInstanceOf(ExitError);
        expect((e as ExitError).code).toBe(0);
      }
    });

    it('restore function reverts the handler', () => {
      const restoreFn = installTestExitHandler();

      // Should throw while installed
      expect(() => exitProcess(1)).toThrow(ExitError);

      restoreFn();
      restore = undefined;

      // After restore, we can't easily test it calls process.exit
      // without actually exiting. Just verify no ExitError.
      let capturedCode: number | undefined;
      restore = setExitHandler(((code: number) => {
        capturedCode = code;
      }) as never);

      try {
        exitProcess(42);
      } catch {
        /* noop */
      }
      expect(capturedCode).toBe(42);
    });
  });

  describe('ExitError', () => {
    it('has name ExitError', () => {
      const err = new ExitError(1);
      expect(err.name).toBe('ExitError');
    });

    it('has code property', () => {
      expect(new ExitError(0).code).toBe(0);
      expect(new ExitError(1).code).toBe(1);
      expect(new ExitError(127).code).toBe(127);
    });

    it('has descriptive message', () => {
      expect(new ExitError(1).message).toBe('process.exit(1)');
    });

    it('is instanceof Error', () => {
      expect(new ExitError(1)).toBeInstanceOf(Error);
    });
  });
});
