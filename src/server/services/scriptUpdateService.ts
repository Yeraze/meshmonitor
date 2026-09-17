/**
 * Update checks and one-click updates for installed user scripts (#5255).
 *
 * Deliberate limits, decided with the maintainer:
 * - **Scripts only.** Community Add-ons (Docker sidecars) are out of scope.
 * - **Never automatic.** MeshMonitor reports that a newer version exists; an
 *   admin with `settings:write` decides to install it. Nothing here runs on a
 *   timer, so no third-party code changes under an operator without a click.
 * - **One backup.** The replaced file is kept so the update can be rolled back.
 *
 * A script's update source is a GitHub file, resolved in this order:
 *   1. `source:` (or `repository:`) in the script's own mm_meta block,
 *   2. an admin-entered source stored in the `scriptUpdateSources` setting,
 *   3. the bundled User Scripts Gallery listing, matched on filename.
 */
import fs from 'fs';
import path from 'path';
import { safeFetch, SsrfBlockedError } from '../utils/ssrfGuard.js';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import {
  formatScriptSource,
  isUpdateAvailable,
  parseScriptSource,
  scriptSourceApiUrl,
  scriptSourceWebUrl,
  type ScriptSource,
} from '../../utils/scriptSource.js';
import galleryEntries from '../data/userScriptsGallery.json' with { type: 'json' };

/** Largest script we will download, matching the gallery's own cap. */
export const MAX_SCRIPT_BYTES = 512 * 1024;

/** Where the replaced file goes, inside the scripts directory. */
export const BACKUP_DIR_NAME = '.backups';

/** Setting holding admin-entered sources: `{ "<filename>": "<owner/repo/path>" }`. */
export const SCRIPT_SOURCES_SETTING = 'scriptUpdateSources';

export interface ScriptUpdateStatus {
  filename: string;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** Where the source came from, so the UI can say why a script is not checkable. */
  sourceOrigin: 'script' | 'manual' | 'gallery' | null;
  source: string | null;
  sourceUrl: string | null;
  hasBackup: boolean;
  backupVersion: string | null;
  error: string | null;
}

interface BackupRecord {
  filename: string;
  previousVersion: string | null;
  newVersion: string | null;
  source: string | null;
  updatedAt: number;
}

/**
 * Gallery paths in the main repo are repo-relative; give them their owner/repo.
 * The owner is hardcoded because the listing is this project's own; a fork that
 * ships its own gallery would need to change it here too.
 */
function sourceFromGalleryPath(githubPath: string): ScriptSource | null {
  const value = githubPath.startsWith('examples/') ? `Yeraze/meshmonitor/${githubPath}` : githubPath;
  return parseScriptSource(value);
}

const galleryByFilename = new Map<string, ScriptSource>();
for (const entry of galleryEntries as Array<{ filename: string; githubPath?: string }>) {
  if (!entry.githubPath) continue;
  const parsed = sourceFromGalleryPath(entry.githubPath);
  if (parsed) galleryByFilename.set(entry.filename, parsed);
}

async function getManualSources(): Promise<Record<string, string>> {
  try {
    const raw = await databaseService.settings.getSetting(SCRIPT_SOURCES_SETTING);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch (error) {
    logger.warn('[scripts] Could not read stored script update sources:', error);
    return {};
  }
}

/** Resolve one script's update source, in the order documented above. */
export async function resolveScriptSource(
  filename: string,
  metaSource?: string | null,
): Promise<{ source: ScriptSource; origin: ScriptUpdateStatus['sourceOrigin'] } | null> {
  const fromMeta = parseScriptSource(metaSource);
  if (fromMeta) return { source: fromMeta, origin: 'script' };

  const manual = parseScriptSource((await getManualSources())[filename]);
  if (manual) return { source: manual, origin: 'manual' };

  const gallery = galleryByFilename.get(filename);
  if (gallery) return { source: gallery, origin: 'gallery' };

  return null;
}

/**
 * Store (or clear, with null) the admin-entered source for one script.
 *
 * This is a read-modify-write of one settings row. Two admins saving sources
 * for different scripts in the same instant would leave only the later write,
 * which is acceptable for a rarely-touched, admin-only field; it is not a
 * hot path worth a lock.
 */
export async function setManualScriptSource(filename: string, value: string | null): Promise<ScriptSource | null> {
  const sources = await getManualSources();
  let parsed: ScriptSource | null = null;
  if (value === null || value.trim() === '') {
    delete sources[filename];
  } else {
    parsed = parseScriptSource(value);
    if (!parsed) throw new Error('Not a GitHub file path. Use owner/repo/path/to/script.py');
    sources[filename] = value.trim();
  }
  await databaseService.settings.setSetting(SCRIPT_SOURCES_SETTING, JSON.stringify(sources));
  return parsed;
}

/**
 * Download a script's current contents from GitHub.
 *
 * Every request goes through safeFetch against a URL built from a parsed
 * source, so a source string can never redirect the fetch off GitHub or at an
 * internal address.
 */
export async function fetchSourceContents(source: ScriptSource): Promise<string> {
  const response = await safeFetch(scriptSourceApiUrl(source), {
    headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'MeshMonitor' },
    signal: AbortSignal.timeout(15000),
  });

  if (response.status === 404) throw new Error('File not found in that repository');
  if (response.status === 403) throw new Error('GitHub rate limit reached, or the repository is private');
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

  const data = await response.json() as { content?: string; encoding?: string; size?: number; type?: string };
  if (data.type && data.type !== 'file') throw new Error('That path is not a file');
  if (typeof data.size === 'number' && data.size > MAX_SCRIPT_BYTES) {
    throw new Error(`File is larger than ${Math.round(MAX_SCRIPT_BYTES / 1024)}KB`);
  }
  if (!data.content || data.encoding !== 'base64') throw new Error('Unexpected response from GitHub');

  const text = Buffer.from(data.content, 'base64').toString('utf8');
  if (text.length > MAX_SCRIPT_BYTES) {
    throw new Error(`File is larger than ${Math.round(MAX_SCRIPT_BYTES / 1024)}KB`);
  }

  const trimmed = text.trimStart();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
    throw new Error('That URL returned a web page, not a script');
  }
  // A NUL byte means we fetched a binary, not source an interpreter can run.
  if (text.indexOf(String.fromCharCode(0)) !== -1) {
    throw new Error('That file is binary, not a script');
  }

  return text;
}

/** Read `version:` out of an mm_meta block, the same shape the inventory parses. */
export function versionFromContents(contents: string): string | null {
  const block = contents.match(/^[#/]{1,2}\s*mm_meta:\s*\n((?:[#/]{1,2}\s+\w+:.*\n?)+)/m);
  if (!block) return null;
  const field = block[1].match(/^[#/]{1,2}\s+version:\s*(.+)$/m);
  const value = field?.[1]?.trim().replace(/^v(?=\d)/i, '');
  return value ? value.slice(0, 20) : null;
}

function backupPaths(scriptsDir: string, filename: string) {
  // basename here as well as in the route: this is a public function, and a
  // future caller that forgets would otherwise write outside the backup
  // directory.
  const safe = path.basename(filename);
  const dir = path.join(scriptsDir, BACKUP_DIR_NAME);
  return { dir, file: path.join(dir, safe), meta: path.join(dir, `${safe}.json`) };
}

/** A version string we are willing to show, from a file anyone could edit. */
function safeVersion(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 20) : null;
}

function readBackupRecord(scriptsDir: string, filename: string): BackupRecord | null {
  const { file, meta } = backupPaths(scriptsDir, filename);
  if (!fs.existsSync(file)) return null;

  const empty: BackupRecord = { filename, previousVersion: null, newVersion: null, source: null, updatedAt: 0 };
  try {
    // The record sits on disk beside the backup, so treat its fields as
    // untrusted: they reach a log line and an API response.
    const raw = JSON.parse(fs.readFileSync(meta, 'utf8')) as Record<string, unknown>;
    return {
      filename,
      previousVersion: safeVersion(raw.previousVersion),
      newVersion: safeVersion(raw.newVersion),
      source: typeof raw.source === 'string' ? raw.source.slice(0, 200) : null,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
  } catch {
    return empty;
  }
}

/**
 * Check one script against its source. Network and parse failures come back as
 * `error` rather than throwing, so one unreachable repo cannot fail the list.
 */
export async function checkScriptForUpdate(
  scriptsDir: string,
  script: { filename: string; version?: string | null; source?: string | null },
): Promise<ScriptUpdateStatus> {
  const backup = readBackupRecord(scriptsDir, script.filename);
  const base: ScriptUpdateStatus = {
    filename: script.filename,
    installedVersion: script.version ?? null,
    latestVersion: null,
    updateAvailable: false,
    sourceOrigin: null,
    source: null,
    sourceUrl: null,
    hasBackup: backup !== null,
    backupVersion: backup?.previousVersion ?? null,
    error: null,
  };

  const resolved = await resolveScriptSource(script.filename, script.source);
  if (!resolved) return base;

  base.sourceOrigin = resolved.origin;
  base.source = formatScriptSource(resolved.source);
  base.sourceUrl = scriptSourceWebUrl(resolved.source);

  try {
    const contents = await fetchSourceContents(resolved.source);
    base.latestVersion = versionFromContents(contents);
    if (!base.latestVersion) {
      base.error = 'The published script declares no mm_meta version';
    } else if (!base.installedVersion) {
      base.error = 'This copy declares no mm_meta version, so it cannot be compared';
    } else {
      base.updateAvailable = isUpdateAvailable(base.installedVersion, base.latestVersion);
    }
  } catch (error) {
    base.error = error instanceof SsrfBlockedError
      ? 'That source was blocked as unsafe'
      : (error instanceof Error ? error.message : 'Update check failed');
  }

  return base;
}

/**
 * Replace a script with the version from its source, keeping one backup.
 *
 * The new file is written to a temporary name and renamed into place, so an
 * interrupted write cannot leave a half-written script that the auto-responder
 * would then execute.
 */
export async function applyScriptUpdate(
  scriptsDir: string,
  script: { filename: string; version?: string | null; source?: string | null },
): Promise<{ filename: string; previousVersion: string | null; newVersion: string | null; source: string }> {
  // Every path below is built from the basename: a caller that skipped the
  // route's own sanitising must not be able to read or write outside the
  // scripts directory.
  const filename = path.basename(script.filename);
  const resolved = await resolveScriptSource(filename, script.source);
  if (!resolved) throw new Error('This script has no update source');

  const filePath = path.join(scriptsDir, filename);
  if (!fs.existsSync(filePath)) throw new Error('Script not found');

  const contents = await fetchSourceContents(resolved.source);
  const newVersion = versionFromContents(contents);

  const { dir, file, meta } = backupPaths(scriptsDir, filename);
  fs.mkdirSync(dir, { recursive: true });
  // Read the version out of the file we are about to replace, so a rollback can
  // name it even when the inventory never parsed one.
  const previousVersion = versionFromContents(fs.readFileSync(filePath, 'utf8')) ?? script.version ?? null;
  fs.copyFileSync(filePath, file);

  const mode = fs.statSync(filePath).mode;
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, contents, { mode });
    fs.renameSync(tmp, filePath);
  } finally {
    // A failed write or rename would otherwise leave the temp file behind for
    // every attempt.
    fs.rmSync(tmp, { force: true });
  }

  const record: BackupRecord = {
    filename,
    previousVersion,
    newVersion,
    source: formatScriptSource(resolved.source),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(meta, JSON.stringify(record, null, 2));

  logger.info(`Updated script ${record.filename}: ${record.previousVersion ?? 'unknown'} -> ${newVersion ?? 'unknown'}`);
  return { filename: record.filename, previousVersion: record.previousVersion, newVersion, source: record.source ?? '' };
}

/** Put the backed-up copy back. */
export function rollbackScriptUpdate(
  scriptsDir: string,
  rawFilename: string,
): { filename: string; restoredVersion: string | null } {
  const filename = path.basename(rawFilename);
  const { file, meta } = backupPaths(scriptsDir, filename);
  if (!fs.existsSync(file)) throw new Error('No backup to roll back to');

  const record = readBackupRecord(scriptsDir, filename);
  const filePath = path.join(scriptsDir, filename);
  const mode = fs.existsSync(filePath) ? fs.statSync(filePath).mode : 0o755;
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    fs.copyFileSync(file, tmp);
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, filePath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  fs.unlinkSync(file);
  if (fs.existsSync(meta)) fs.unlinkSync(meta);

  logger.info(`Rolled back script ${filename} to ${record?.previousVersion ?? 'the previous version'}`);
  return { filename, restoredVersion: record?.previousVersion ?? null };
}
