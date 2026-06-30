import type { DrsApi } from '../shared/ipc-types';

export * from '../shared/ipc-types';

// Augment the global Window with the DRS bridge exposed by the preload script.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  interface Window {
    drs: DrsApi;
  }
}

