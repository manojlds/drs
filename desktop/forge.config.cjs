// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { join } = require('node:path');

// Electron Forge packaging config.
//
// Packaged builds keep the prebuilt renderer (dist-renderer/) and the Electron
// main process (electron/). Source TS and config files are excluded. Packaged
// builds locate the DRS CLI via the DRS_CLI env var or a global `drs` on PATH;
// see README.md.
module.exports = {
  packagerConfig: {
    asar: true,
    name: 'DRS Desktop',
    executableName: 'drs-desktop',
    ignore: [
      /^\/src$/,
      /^\/vite\.config\./,
      /^\/tsconfig/,
      /^\/forge\.config\./,
      /^\/index\.html$/,
      /^\/README/,
      /^\/\.gitignore$/,
    ],
    extraResource: [
      // Keep the renderer build accessible at process.resourcesPath/renderer.
      join(__dirname, 'dist-renderer'),
    ],
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32', 'linux'],
    },
  ],
  rebuildConfig: {},
};
