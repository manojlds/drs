import { createHash } from 'crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getBuiltInSkillPaths } from '../runtime/built-in-paths.js';

export interface SkillStatus {
  name: string;
  bundled: boolean;
  installed: boolean;
  installedPath: string;
  modified: boolean;
  outdated: boolean;
}

interface SkillLockEntry {
  source: 'bundled';
  installedPath: string;
  contentHash: string;
}

interface SkillLock {
  skills: Record<string, SkillLockEntry>;
}

const PROJECT_SKILL_DIR = '.agents/skills';
const LOCK_PATH = '.drs/skills-lock.json';

export function listBundledSkills(): string[] {
  const names = new Set<string>();
  for (const base of getBuiltInSkillPaths()) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(base, entry.name, 'SKILL.md'))) {
        names.add(entry.name);
      }
    }
  }
  return [...names].sort();
}

export function getSkillStatuses(workingDir: string): SkillStatus[] {
  return listBundledSkills().map((name) => getSkillStatus(workingDir, name));
}

export function getSkillStatus(workingDir: string, name: string): SkillStatus {
  const source = resolveBundledSkillPath(name);
  const installedPath = join(PROJECT_SKILL_DIR, name);
  const absoluteInstalledPath = join(workingDir, installedPath);
  const lock = readSkillLock(workingDir);
  const lockEntry = lock.skills[name];
  const installed = existsSync(join(absoluteInstalledPath, 'SKILL.md'));
  const currentHash = installed ? hashDirectory(absoluteInstalledPath) : '';
  const sourceHash = source ? hashDirectory(source) : '';
  return {
    name,
    bundled: !!source,
    installed,
    installedPath,
    modified: installed && !!lockEntry && currentHash !== lockEntry.contentHash,
    outdated: installed && !!source && currentHash !== sourceHash,
  };
}

export function installBundledSkill(
  workingDir: string,
  name: string,
  options: { force?: boolean } = {}
): SkillStatus {
  const source = resolveBundledSkillPath(name);
  if (!source) throw new Error(`Bundled skill not found: ${name}`);

  const target = join(workingDir, PROJECT_SKILL_DIR, name);
  const lock = readSkillLock(workingDir);
  const lockEntry = lock.skills[name];
  if (existsSync(join(target, 'SKILL.md')) && !options.force) {
    const currentHash = hashDirectory(target);
    const sourceHash = hashDirectory(source);
    const unmodifiedManaged = currentHash === lockEntry?.contentHash;
    if (!unmodifiedManaged && currentHash !== sourceHash) {
      throw new Error(
        `Skill ${name} is already installed and has local changes. Use --force to overwrite.`
      );
    }
  }

  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
  const contentHash = hashDirectory(target);
  lock.skills[name] = {
    source: 'bundled',
    installedPath: join(PROJECT_SKILL_DIR, name),
    contentHash,
  };
  writeSkillLock(workingDir, lock);
  return getSkillStatus(workingDir, name);
}

export function installFactorySkills(
  workingDir: string,
  options: { force?: boolean } = {}
): SkillStatus[] {
  return [
    installBundledSkill(workingDir, 'drs-factory-planning', options),
    installBundledSkill(workingDir, 'drs-factory-stories', options),
  ];
}

export function syncBundledSkills(workingDir: string): SkillStatus[] {
  const lock = readSkillLock(workingDir);
  const synced: SkillStatus[] = [];
  for (const name of Object.keys(lock.skills).sort()) {
    const source = resolveBundledSkillPath(name);
    if (!source) continue;
    const target = join(workingDir, PROJECT_SKILL_DIR, name);
    if (!existsSync(join(target, 'SKILL.md'))) {
      synced.push(installBundledSkill(workingDir, name));
      continue;
    }
    const currentHash = hashDirectory(target);
    if (currentHash !== lock.skills[name].contentHash) {
      synced.push(getSkillStatus(workingDir, name));
      continue;
    }
    if (currentHash !== hashDirectory(source)) {
      synced.push(installBundledSkill(workingDir, name));
    } else {
      synced.push(getSkillStatus(workingDir, name));
    }
  }
  return synced;
}

function resolveBundledSkillPath(name: string): string | null {
  for (const base of getBuiltInSkillPaths()) {
    const candidate = join(base, name);
    if (existsSync(join(candidate, 'SKILL.md'))) return candidate;
  }
  return null;
}

function readSkillLock(workingDir: string): SkillLock {
  const lockPath = join(workingDir, LOCK_PATH);
  if (!existsSync(lockPath)) return { skills: {} };
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<SkillLock>;
    return { skills: parsed.skills && typeof parsed.skills === 'object' ? parsed.skills : {} };
  } catch {
    return { skills: {} };
  }
}

function writeSkillLock(workingDir: string, lock: SkillLock): void {
  const lockPath = join(workingDir, LOCK_PATH);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf-8');
}

function hashDirectory(dir: string): string {
  const hash = createHash('sha256');
  for (const file of listFiles(dir)) {
    const rel = file.slice(dir.length + 1);
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
