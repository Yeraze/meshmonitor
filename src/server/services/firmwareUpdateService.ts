/**
 * Firmware Update Service
 *
 * Core service for Gateway OTA firmware updates. Handles:
 * - Fetching firmware releases from the Meshtastic GitHub repo
 * - Channel-based release filtering (stable/alpha/custom)
 * - Firmware asset and binary matching
 * - Update status management with real-time event emission
 * - Background polling for new releases
 * - CLI command execution and backup management
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { dataEventEmitter } from './dataEventEmitter.js';
// Re-exported for consumers; used by pipeline methods added in Task 3
export { getBoardName, getPlatformForBoard, isOtaCapable, getHardwareDisplayName } from './firmwareHardwareMap.js';

// ---- Types ----

export interface FirmwareRelease {
  tagName: string;
  version: string;
  prerelease: boolean;
  publishedAt: string;
  htmlUrl: string;
  assets: FirmwareAsset[];
}

export interface FirmwareAsset {
  name: string;
  size: number;
  downloadUrl: string;
}

export interface FirmwareManifest {
  version: string;
  targets: Array<{ board: string; platform: string }>;
}

export type FirmwareChannel = 'stable' | 'alpha' | 'custom';

export type UpdateStep = 'preflight' | 'backup' | 'download' | 'extract' | 'flash' | 'verify';

export type UpdateState = 'idle' | 'awaiting-confirm' | 'in-progress' | 'success' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  step: UpdateStep | null;
  message: string;
  progress?: number;
  logs: string[];
  targetVersion?: string;
  error?: string;
  preflightInfo?: {
    currentVersion: string;
    targetVersion: string;
    gatewayIp: string;
    hwModel: string;
    boardName: string;
    platform: string;
  };
  backupPath?: string;
  downloadUrl?: string;
  downloadSize?: number;
  matchedFile?: string;
  rejectedFiles?: Array<{ name: string; reason: string }>;
}

// ---- GitHub API response types (raw) ----

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  prerelease: boolean;
  published_at: string;
  html_url: string;
  assets: GitHubAsset[];
}

// ---- Constants ----

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/meshtastic/firmware/releases?per_page=20';
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const INITIAL_CHECK_DELAY_MS = 30 * 1000; // 30 seconds
const BACKUP_DIR = path.join('data', 'firmware-backups');

// ---- Service ----

function createIdleStatus(): UpdateStatus {
  return {
    state: 'idle',
    step: null,
    message: '',
    logs: [],
  };
}

export class FirmwareUpdateService {
  private cachedReleases: FirmwareRelease[] = [];
  private lastFetchTime: number = 0;
  private etag: string | null = null;

  private status: UpdateStatus = createIdleStatus();
  private activeProcess: ChildProcess | null = null;
  private tempDir: string | null = null;

  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private initialCheckTimeout: ReturnType<typeof setTimeout> | null = null;

  // ---- Release Fetching ----

  /**
   * Fetch firmware releases from the Meshtastic GitHub repo.
   * Uses ETag for conditional requests (304 Not Modified returns cached).
   * On error, returns cached or empty array.
   */
  async fetchReleases(): Promise<FirmwareRelease[]> {
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'MeshMonitor',
      };

      if (this.etag) {
        headers['If-None-Match'] = this.etag;
      }

      const response = await fetch(GITHUB_RELEASES_URL, { headers });

      if (response.status === 304) {
        logger.debug('[FirmwareUpdateService] Releases not modified (304), using cache');
        return this.cachedReleases;
      }

      if (!response.ok) {
        logger.warn(`[FirmwareUpdateService] GitHub API returned ${response.status}`);
        return this.cachedReleases.length > 0 ? this.cachedReleases : [];
      }

      // Update ETag
      const newEtag = response.headers.get('etag') ?? (response.headers as any).get?.('etag') ?? null;
      if (newEtag) {
        this.etag = newEtag;
      }

      const rawReleases: GitHubRelease[] = await response.json();
      const releases = rawReleases.map((r) => this.mapRelease(r));

      this.cachedReleases = releases;
      this.lastFetchTime = Date.now();

      logger.info(`[FirmwareUpdateService] Fetched ${releases.length} firmware releases`);
      return releases;
    } catch (error) {
      logger.error('[FirmwareUpdateService] Error fetching releases:', error);
      return this.cachedReleases.length > 0 ? this.cachedReleases : [];
    }
  }

  /**
   * Filter releases by channel.
   * 'stable' = non-prerelease only, 'alpha' = all, 'custom' = all.
   */
  filterByChannel(releases: FirmwareRelease[], channel: FirmwareChannel): FirmwareRelease[] {
    if (channel === 'stable') {
      return releases.filter((r) => !r.prerelease);
    }
    // 'alpha' and 'custom' return all
    return releases;
  }

  /**
   * Find the zip asset matching `firmware-${platform}-*.zip` pattern in a release.
   */
  findFirmwareZipAsset(release: FirmwareRelease, platform: string): FirmwareAsset | null {
    const pattern = new RegExp(`^firmware-${platform}-.*\\.zip$`);
    const asset = release.assets.find((a) => pattern.test(a.name));
    return asset ?? null;
  }

  /**
   * Check if a board exists in the manifest targets array.
   */
  checkBoardInManifest(manifest: FirmwareManifest, boardName: string): boolean {
    return manifest.targets.some((t) => t.board === boardName);
  }

  /**
   * Find the correct firmware .bin in a list of extracted file names.
   * Uses strict regex: firmware-${boardName}-\d+\.\d+\.\d+\.[a-f0-9]+\.bin$
   * Rejects .factory.bin and other variants.
   */
  findFirmwareBinary(
    files: string[],
    boardName: string,
    _version: string
  ): { matched: string | null; rejected: Array<{ name: string; reason: string }> } {
    const strictPattern = new RegExp(
      `^firmware-${boardName}-\\d+\\.\\d+\\.\\d+\\.[a-f0-9]+\\.bin$`
    );
    const rejected: Array<{ name: string; reason: string }> = [];
    let matched: string | null = null;

    for (const file of files) {
      // Skip non-bin files
      if (!file.endsWith('.bin')) {
        continue;
      }

      // Check if it looks like a firmware file for this board
      if (!file.startsWith(`firmware-${boardName}-`)) {
        // Not for this board — skip silently (don't add to rejected unless it's firmware-*)
        if (file.startsWith('firmware-')) {
          rejected.push({ name: file, reason: 'wrong board name' });
        } else {
          rejected.push({ name: file, reason: 'not a firmware binary' });
        }
        continue;
      }

      // Reject factory binaries
      if (file.includes('.factory.')) {
        rejected.push({ name: file, reason: 'factory binary' });
        continue;
      }

      // Check strict pattern match
      if (strictPattern.test(file)) {
        matched = file;
      } else {
        rejected.push({ name: file, reason: 'does not match expected naming pattern' });
      }
    }

    return { matched, rejected };
  }

  // ---- Settings ----

  /**
   * Get the configured firmware channel. Defaults to 'stable'.
   */
  async getChannel(): Promise<FirmwareChannel> {
    const stored = await databaseService.getSettingAsync('firmwareChannel');
    if (stored === 'alpha' || stored === 'stable' || stored === 'custom') {
      return stored;
    }
    return 'stable';
  }

  /**
   * Set the firmware channel.
   */
  async setChannel(channel: FirmwareChannel): Promise<void> {
    await databaseService.setSettingAsync('firmwareChannel', channel);
  }

  /**
   * Get the custom firmware URL, or null if not set.
   */
  async getCustomUrl(): Promise<string | null> {
    return await databaseService.getSettingAsync('firmwareCustomUrl');
  }

  /**
   * Set the custom firmware URL.
   */
  async setCustomUrl(url: string): Promise<void> {
    await databaseService.setSettingAsync('firmwareCustomUrl', url);
  }

  // ---- Status Management ----

  /**
   * Get a copy of the current update status.
   */
  getStatus(): UpdateStatus {
    return {
      ...this.status,
      logs: [...this.status.logs],
      preflightInfo: this.status.preflightInfo
        ? { ...this.status.preflightInfo }
        : undefined,
      rejectedFiles: this.status.rejectedFiles
        ? [...this.status.rejectedFiles]
        : undefined,
    };
  }

  /**
   * Reset the update status to idle.
   */
  resetStatus(): void {
    this.status = createIdleStatus();
    this.updateStatus({});
  }

  /**
   * Cancel an active update process.
   * Kills any active child process, cleans temp directory, resets to idle.
   */
  cancelUpdate(): void {
    if (this.activeProcess) {
      try {
        this.activeProcess.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
      this.activeProcess = null;
    }
    this.cleanupTempDir();
    this.status = createIdleStatus();
    this.updateStatus({ message: 'Update cancelled' });
    logger.info('[FirmwareUpdateService] Update cancelled by user');
  }

  // ---- Polling ----

  /**
   * Start background polling for new firmware releases.
   * Respects FIRMWARE_CHECK_ENABLED env var (defaults to enabled).
   * Interval configurable via FIRMWARE_CHECK_INTERVAL env var (ms).
   */
  startPolling(): void {
    if (process.env.FIRMWARE_CHECK_ENABLED === 'false') {
      logger.info('[FirmwareUpdateService] Firmware polling disabled via FIRMWARE_CHECK_ENABLED=false');
      return;
    }

    const intervalMs = process.env.FIRMWARE_CHECK_INTERVAL
      ? parseInt(process.env.FIRMWARE_CHECK_INTERVAL, 10)
      : DEFAULT_CHECK_INTERVAL_MS;

    // Initial check after a short delay
    this.initialCheckTimeout = setTimeout(async () => {
      try {
        await this.fetchReleases();
      } catch (error) {
        logger.error('[FirmwareUpdateService] Initial release check failed:', error);
      }
    }, INITIAL_CHECK_DELAY_MS);

    // Recurring check
    this.pollingInterval = setInterval(async () => {
      try {
        await this.fetchReleases();
      } catch (error) {
        logger.error('[FirmwareUpdateService] Periodic release check failed:', error);
      }
    }, intervalMs);

    logger.info(`[FirmwareUpdateService] Polling started (interval: ${intervalMs}ms)`);
  }

  /**
   * Stop background polling.
   */
  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.initialCheckTimeout) {
      clearTimeout(this.initialCheckTimeout);
      this.initialCheckTimeout = null;
    }
  }

  // ---- Utility ----

  /**
   * Get the cached releases without fetching.
   */
  getCachedReleases(): FirmwareRelease[] {
    return [...this.cachedReleases];
  }

  /**
   * Get the timestamp of the last successful fetch.
   */
  getLastFetchTime(): number {
    return this.lastFetchTime;
  }

  /**
   * Run a CLI command and capture output.
   * Appends stdout/stderr to status logs.
   */
  runCliCommand(
    command: string,
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.activeProcess = proc;

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        this.appendLog(text.trimEnd());
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        this.appendLog(text.trimEnd());
      });

      proc.on('close', (code) => {
        this.activeProcess = null;
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      proc.on('error', (error) => {
        this.activeProcess = null;
        this.appendLog(`Command error: ${error.message}`);
        resolve({ stdout, stderr, exitCode: 1 });
      });
    });
  }

  /**
   * Ensure the firmware backup directory exists.
   */
  ensureBackupDir(): void {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      logger.info(`[FirmwareUpdateService] Created backup directory: ${BACKUP_DIR}`);
    }
  }

  /**
   * List available firmware backups.
   */
  listBackups(): Array<{ filename: string; path: string; timestamp: number; size: number }> {
    this.ensureBackupDir();
    try {
      const files = fs.readdirSync(BACKUP_DIR);
      return files
        .filter((f) => f.endsWith('.bin'))
        .map((filename) => {
          const filePath = path.join(BACKUP_DIR, filename);
          const stats = fs.statSync(filePath);
          return {
            filename,
            path: filePath,
            timestamp: stats.mtimeMs,
            size: stats.size,
          };
        })
        .sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      logger.error('[FirmwareUpdateService] Error listing backups:', error);
      return [];
    }
  }

  // ---- Private helpers ----

  /**
   * Map a raw GitHub release object to our FirmwareRelease type.
   */
  private mapRelease(raw: GitHubRelease): FirmwareRelease {
    return {
      tagName: raw.tag_name,
      version: raw.tag_name.replace(/^v/, ''),
      prerelease: raw.prerelease,
      publishedAt: raw.published_at,
      htmlUrl: raw.html_url,
      assets: raw.assets.map((a) => ({
        name: a.name,
        size: a.size,
        downloadUrl: a.browser_download_url,
      })),
    };
  }

  /**
   * Merge partial status update into current status and emit event.
   */
  private updateStatus(partial: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...partial };
    dataEventEmitter.emit('data', {
      type: 'firmware:status',
      data: this.getStatus(),
      timestamp: Date.now(),
    });
  }

  /**
   * Append a message to status logs and emit update.
   */
  private appendLog(message: string): void {
    this.status.logs.push(message);
    this.updateStatus({});
  }

  /**
   * Clean up temporary directory if one exists.
   */
  private cleanupTempDir(): void {
    if (this.tempDir && fs.existsSync(this.tempDir)) {
      try {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
        logger.debug(`[FirmwareUpdateService] Cleaned up temp dir: ${this.tempDir}`);
      } catch (error) {
        logger.warn(`[FirmwareUpdateService] Failed to clean up temp dir: ${this.tempDir}`, error);
      }
      this.tempDir = null;
    }
  }
}

export const firmwareUpdateService = new FirmwareUpdateService();
