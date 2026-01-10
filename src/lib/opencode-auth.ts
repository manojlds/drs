/**
 * OpenCode authentication utilities
 * Handles writing API keys to OpenCode's auth.json file
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * OpenCode auth.json structure
 */
interface AuthConfig {
  [providerId: string]: {
    type: string;
    key?: string;
    access?: string;
    refresh?: string;
  };
}

/**
 * Get the path to OpenCode's auth.json file
 */
export function getAuthJsonPath(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, '.local', 'share', 'opencode', 'auth.json');
}

/**
 * Read existing auth.json or return empty config
 */
function readAuthJson(authPath: string): AuthConfig {
  try {
    if (fs.existsSync(authPath)) {
      const content = fs.readFileSync(authPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error(`Warning: Failed to read auth.json: ${error}`);
  }
  return {};
}

/**
 * Write auth.json with proper directory creation
 */
function writeAuthJson(authPath: string, config: AuthConfig): void {
  try {
    // Ensure directory exists
    const dir = path.dirname(authPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write with proper formatting
    fs.writeFileSync(authPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write auth.json: ${error}`);
  }
}

/**
 * Setup OpenCode Zen authentication from environment variable
 * Reads OPENCODE_ZEN_API_KEY and writes it to auth.json
 */
export function setupOpencodeZenAuth(): void {
  const apiKey = process.env.OPENCODE_ZEN_API_KEY;

  if (!apiKey) {
    // No API key provided, skip setup
    return;
  }

  try {
    const authPath = getAuthJsonPath();
    const authConfig = readAuthJson(authPath);

    // Add or update the opencode provider (OpenCode Zen)
    authConfig['opencode'] = {
      type: 'api',
      key: apiKey,
    };

    writeAuthJson(authPath, authConfig);
    console.log('✅ OpenCode Zen authentication configured from OPENCODE_ZEN_API_KEY');
  } catch (error) {
    console.error(`⚠️  Failed to setup OpenCode Zen auth: ${error}`);
    throw error;
  }
}

/**
 * Setup authentication for a custom provider
 */
export function setupProviderAuth(providerId: string, apiKey: string): void {
  try {
    const authPath = getAuthJsonPath();
    const authConfig = readAuthJson(authPath);

    // Add or update the provider
    authConfig[providerId] = {
      type: 'api',
      key: apiKey,
    };

    writeAuthJson(authPath, authConfig);
    console.log(`✅ ${providerId} authentication configured`);
  } catch (error) {
    console.error(`⚠️  Failed to setup ${providerId} auth: ${error}`);
    throw error;
  }
}

/**
 * Clear authentication for a provider
 */
export function clearProviderAuth(providerId: string): void {
  try {
    const authPath = getAuthJsonPath();
    const authConfig = readAuthJson(authPath);

    if (authConfig[providerId]) {
      delete authConfig[providerId];
      writeAuthJson(authPath, authConfig);
      console.log(`✅ ${providerId} authentication cleared`);
    }
  } catch (error) {
    console.error(`⚠️  Failed to clear ${providerId} auth: ${error}`);
    throw error;
  }
}
