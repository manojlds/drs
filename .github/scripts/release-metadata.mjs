import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { isDeepStrictEqual } from 'util';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function fail(message) {
  throw new Error(message);
}

function parseSemVerParts(value) {
  if (typeof value !== 'string' || value.trim() !== value) {
    fail('Version must not contain leading or trailing whitespace.');
  }
  const match = SEMVER_PATTERN.exec(value);
  if (!match) fail(`Invalid exact SemVer: ${value}`);
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4],
  };
}

export function parseExactSemVer(value) {
  const parts = parseSemVerParts(value);
  return {
    version: value,
    tag: `v${value}`,
    npmTag: parts.prerelease === undefined ? 'latest' : 'next',
    prerelease: parts.prerelease ?? null,
    baseVersion: `${parts.major}.${parts.minor}.${parts.patch}`,
  };
}

function compareNumericIdentifiers(left, right) {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
}

export function compareSemVer(left, right) {
  const leftParts = parseSemVerParts(left);
  const rightParts = parseSemVerParts(right);
  for (const field of ['major', 'minor', 'patch']) {
    const comparison = compareNumericIdentifiers(leftParts[field], rightParts[field]);
    if (comparison !== 0) return comparison;
  }
  if (leftParts.prerelease === undefined) return rightParts.prerelease === undefined ? 0 : 1;
  if (rightParts.prerelease === undefined) return -1;

  const leftIdentifiers = leftParts.prerelease.split('.');
  const rightIdentifiers = rightParts.prerelease.split('.');
  for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index++) {
    const leftIdentifier = leftIdentifiers[index];
    const rightIdentifier = rightIdentifiers[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric)
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function assertGreaterVersion(candidate, current) {
  if (compareSemVer(candidate, current) <= 0) {
    fail(`Version ${candidate} must be greater than ${current}.`);
  }
  return { candidate, current };
}

export function validateStableTag(tag) {
  if (!tag.startsWith('v')) fail(`Invalid stable release tag: ${tag}`);
  const metadata = parseExactSemVer(tag.slice(1));
  if (metadata.prerelease !== null) fail(`Release base tag must be stable: ${tag}`);
  return metadata;
}

export function validateDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) fail(`Invalid release date: ${value}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) fail(`Invalid release date: ${value}`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf-8'));
}

export function checkPackage(tag) {
  const packageJson = readJson('package.json');
  const packageLock = readJson('package-lock.json');
  const version = packageJson.version;
  const metadata = parseExactSemVer(version);
  if (tag !== metadata.tag) {
    fail(`Tag ${tag} does not match package version ${version}.`);
  }
  if (packageLock.version !== version || packageLock.packages?.['']?.version !== version) {
    fail('package.json and package-lock.json versions do not agree.');
  }
  return metadata;
}

function withoutVersionFields(packageJson, packageLock) {
  const normalizedPackage = structuredClone(packageJson);
  const normalizedLock = structuredClone(packageLock);
  delete normalizedPackage.version;
  delete normalizedLock.version;
  if (normalizedLock.packages?.['']) delete normalizedLock.packages[''].version;
  return { packageJson: normalizedPackage, packageLock: normalizedLock };
}

export function checkVersionOnly(expectedVersion) {
  const packageJson = readJson('package.json');
  const packageLock = readJson('package-lock.json');
  if (packageJson.version !== expectedVersion) {
    fail(`Expected package version ${expectedVersion} but found ${packageJson.version}.`);
  }
  const baselinePackage = JSON.parse(
    execFileSync('git', ['show', 'HEAD:package.json'], { encoding: 'utf-8' })
  );
  const baselineLock = JSON.parse(
    execFileSync('git', ['show', 'HEAD:package-lock.json'], { encoding: 'utf-8' })
  );
  const current = withoutVersionFields(packageJson, packageLock);
  const baseline = withoutVersionFields(baselinePackage, baselineLock);
  if (!isDeepStrictEqual(current, baseline)) {
    fail('Release preparation changed package metadata beyond version fields.');
  }
  return { from: baselinePackage.version, version: expectedVersion };
}

function changelogHeadings() {
  return readFileSync('CHANGELOG.md', 'utf-8')
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('## '));
}

export function checkChangelog(version, expectedDate) {
  const metadata = parseExactSemVer(version);
  const releasePrefix = `## ${version} - `;
  const matching = changelogHeadings().filter((heading) => heading.startsWith(releasePrefix));
  if (matching.length !== 1) {
    fail(`CHANGELOG.md must contain exactly one release heading for ${version}.`);
  }
  const date = matching[0].slice(releasePrefix.length);
  validateDate(date);
  if (expectedDate !== undefined && date !== expectedDate) {
    fail(`CHANGELOG.md release date ${date} does not match ${expectedDate}.`);
  }
  const stalePrereleases = changelogHeadings().filter(
    (heading) =>
      heading.startsWith(`## ${metadata.baseVersion}-`) && !heading.startsWith(releasePrefix)
  );
  if (stalePrereleases.length > 0) {
    fail(`CHANGELOG.md contains stale prerelease sections for ${metadata.baseVersion}.`);
  }
  return { ...metadata, date };
}

export function checkPackManifest(path, expectedVersion) {
  const parsed = readJson(path);
  const result = Array.isArray(parsed) ? parsed[0] : undefined;
  if (!result || result.version !== expectedVersion || !Array.isArray(result.files)) {
    fail('npm pack manifest has unexpected package metadata.');
  }
  const files = new Set(result.files.map((file) => file.path));
  for (const required of [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/cli/index.js',
    '.pi/workflows/github-pr-review.yaml',
    '.wiki-site/.vitepress/config.mts',
  ]) {
    if (!files.has(required)) fail(`npm pack manifest is missing ${required}.`);
  }
  const forbidden = [...files].find(
    (file) =>
      file.startsWith('src/') || file.startsWith('.github/') || /(^|\/)dist\/.*\.test\./u.test(file)
  );
  if (forbidden) fail(`npm pack manifest contains forbidden path ${forbidden}.`);
  return { version: result.version, files: files.size };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'validate-version' && args.length === 1) print(parseExactSemVer(args[0]));
  else if (command === 'validate-date' && args.length === 1) print({ date: validateDate(args[0]) });
  else if (command === 'validate-stable-tag' && args.length === 1)
    print(validateStableTag(args[0]));
  else if (command === 'assert-greater' && args.length === 2)
    print(assertGreaterVersion(args[0], args[1]));
  else if (command === 'check-package' && args.length === 1) print(checkPackage(args[0]));
  else if (command === 'check-version-only' && args.length === 1) print(checkVersionOnly(args[0]));
  else if (command === 'check-changelog' && args.length === 2)
    print(checkChangelog(args[0], args[1]));
  else if (command === 'check-changelog-version' && args.length === 1)
    print(checkChangelog(args[0]));
  else if (command === 'check-pack' && args.length === 2)
    print(checkPackManifest(args[0], args[1]));
  else if (command === 'latest-stable-tag' && args.length === 0) {
    const tag = readFileSync(0, 'utf-8')
      .split(/\r?\n/u)
      .find((candidate) => {
        try {
          validateStableTag(candidate);
          return true;
        } catch {
          return false;
        }
      });
    if (!tag) fail('No reachable stable release tag found.');
    print({ tag });
  } else fail('Unsupported release metadata command or arguments.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
