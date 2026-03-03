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
import {
  getBoardName,
  getPlatformForBoard,
  isOtaCapable,
  getHardwareDisplayName,
} from './firmwareHardwareMap.js';
// Re-export for consumers
export { getBoardName, getPlatformForBoard, isOtaCapable, getHardwareDisplayName };

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

  /** Returns the temp directory used during download/extract, or null if not set */
  getTempDir(): string | null {
    return this.tempDir;
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

  // ---- OTA Pipeline ----

  /**
   * Step 1: Validate hardware and set status to awaiting-confirm with preflight info.
   * Throws if state is not idle, hardware is unknown, not OTA-capable, or no zip found.
   */
  startPreflight(params: {
    currentVersion: string;
    targetVersion: string;
    targetRelease: FirmwareRelease;
    gatewayIp: string;
    hwModel: number;
  }): void {
    if (this.status.state !== 'idle') {
      throw new Error('Cannot start preflight: state is not idle');
    }

    const boardName = getBoardName(params.hwModel);
    if (!boardName) {
      throw new Error(`Unknown hardware model ${params.hwModel}: cannot determine board name`);
    }

    const platform = getPlatformForBoard(boardName);
    if (!platform || !isOtaCapable(platform)) {
      throw new Error(
        `Board "${boardName}" (platform: ${platform ?? 'unknown'}) is not OTA capable`
      );
    }

    const zipAsset = this.findFirmwareZipAsset(params.targetRelease, platform);
    if (!zipAsset) {
      throw new Error(
        `No firmware zip found for platform "${platform}" in release ${params.targetRelease.tagName}`
      );
    }

    const displayName = getHardwareDisplayName(params.hwModel);

    this.updateStatus({
      state: 'awaiting-confirm',
      step: 'preflight',
      message: `Preflight complete. Ready to update ${displayName} from ${params.currentVersion} to ${params.targetVersion}`,
      targetVersion: params.targetVersion,
      downloadUrl: zipAsset.downloadUrl,
      preflightInfo: {
        currentVersion: params.currentVersion,
        targetVersion: params.targetVersion,
        gatewayIp: params.gatewayIp,
        hwModel: displayName,
        boardName,
        platform,
      },
    });

    logger.info(
      `[FirmwareUpdateService] Preflight passed for ${displayName} (${boardName}/${platform})`
    );
  }

  /**
   * Step 2: Execute config backup via meshtastic CLI.
   * Returns the path to the backup file.
   */
  async executeBackup(gatewayIp: string, nodeId: string): Promise<string> {
    this.updateStatus({
      state: 'in-progress',
      step: 'backup',
      message: `Backing up config from ${gatewayIp}...`,
    });

    try {
      this.ensureBackupDir();

      const result = await this.runCliCommand('meshtastic', [
        '--host', gatewayIp,
        '--export-config',
      ]);

      if (result.exitCode !== 0) {
        throw new Error(`Backup command failed with exit code ${result.exitCode}: ${result.stderr}`);
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(BACKUP_DIR, `config-${nodeId}-${timestamp}.yaml`);
      fs.writeFileSync(backupPath, result.stdout, 'utf-8');

      this.updateStatus({
        state: 'awaiting-confirm',
        step: 'backup',
        message: `Config backed up to ${backupPath}`,
        backupPath,
      });

      logger.info(`[FirmwareUpdateService] Config backup saved: ${backupPath}`);
      return backupPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus({
        state: 'error',
        step: 'backup',
        message: `Backup failed: ${message}`,
        error: message,
      });
      throw error;
    }
  }

  /**
   * Step 3: Download firmware zip from URL.
   * Returns the path to the downloaded zip.
   */
  async executeDownload(downloadUrl: string): Promise<string> {
    this.updateStatus({
      state: 'in-progress',
      step: 'download',
      message: `Downloading firmware from ${downloadUrl}...`,
    });

    try {
      const tempDir = fs.mkdtempSync(path.join('data', 'firmware-tmp-'));
      this.tempDir = tempDir;

      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const zipPath = path.join(tempDir, 'firmware.zip');
      fs.writeFileSync(zipPath, Buffer.from(arrayBuffer));

      const downloadSize = arrayBuffer.byteLength;

      this.updateStatus({
        state: 'awaiting-confirm',
        step: 'download',
        message: `Downloaded ${(downloadSize / 1024 / 1024).toFixed(1)} MB`,
        downloadSize,
      });

      logger.info(`[FirmwareUpdateService] Downloaded firmware: ${zipPath} (${downloadSize} bytes)`);
      return zipPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.cleanupTempDir();
      this.updateStatus({
        state: 'error',
        step: 'download',
        message: `Download failed: ${message}`,
        error: message,
      });
      throw error;
    }
  }

  /**
   * Step 4: Extract firmware zip and find matching binary for board.
   * Returns the path to the matched firmware binary.
   */
  async executeExtract(zipPath: string, boardName: string, version: string): Promise<string> {
    this.updateStatus({
      state: 'in-progress',
      step: 'extract',
      message: 'Extracting firmware zip...',
    });

    try {
      const extractDir = path.join(path.dirname(zipPath), 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });

      const result = await this.runCliCommand('unzip', ['-o', zipPath, '-d', extractDir]);
      if (result.exitCode !== 0) {
        throw new Error(`Extraction failed with exit code ${result.exitCode}: ${result.stderr}`);
      }

      const extractedFiles = fs.readdirSync(extractDir);
      const { matched, rejected } = this.findFirmwareBinary(extractedFiles, boardName, version);

      if (!matched) {
        throw new Error(
          `No matching firmware binary found for board "${boardName}" in extracted files`
        );
      }

      const firmwarePath = path.join(extractDir, matched);

      this.updateStatus({
        state: 'awaiting-confirm',
        step: 'extract',
        message: `Found firmware binary: ${matched}`,
        matchedFile: matched,
        rejectedFiles: rejected,
      });

      logger.info(`[FirmwareUpdateService] Matched firmware binary: ${matched}`);
      return firmwarePath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.cleanupTempDir();
      this.updateStatus({
        state: 'error',
        step: 'extract',
        message: `Extraction failed: ${message}`,
        error: message,
      });
      throw error;
    }
  }

  /**
   * Step 5: Flash firmware to the gateway via OTA.
   */
  async executeFlash(gatewayIp: string, firmwarePath: string): Promise<void> {
    this.updateStatus({
      state: 'in-progress',
      step: 'flash',
      message: `Flashing firmware to ${gatewayIp}...`,
    });

    try {
      const result = await this.runCliCommand('meshtastic', [
        '--host', gatewayIp,
        '--ota-update', firmwarePath,
      ]);

      if (result.exitCode !== 0) {
        throw new Error(`Flash command failed with exit code ${result.exitCode}: ${result.stderr}`);
      }

      this.updateStatus({
        state: 'awaiting-confirm',
        step: 'flash',
        message: 'Firmware flashed successfully. Device is rebooting — wait for it to reconnect before verifying.',
      });

      logger.info('[FirmwareUpdateService] OTA flash completed successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus({
        state: 'error',
        step: 'flash',
        message: `Flash failed: ${message}`,
        error: message,
      });
      throw error;
    } finally {
      this.cleanupTempDir();
    }
  }

  /**
   * Step 6: Verify that the firmware version matches the target after reboot.
   */
  verifyUpdate(newFirmwareVersion: string, targetVersion: string): void {
    if (newFirmwareVersion.includes(targetVersion) || targetVersion.includes(newFirmwareVersion)) {
      this.updateStatus({
        state: 'success',
        step: 'verify',
        message: `Firmware update verified: running ${newFirmwareVersion}`,
      });
      logger.info(`[FirmwareUpdateService] Update verified: ${newFirmwareVersion}`);
    } else {
      this.updateStatus({
        state: 'error',
        step: 'verify',
        message: `Version mismatch: expected ${targetVersion}, got ${newFirmwareVersion}`,
        error: `Version mismatch: expected ${targetVersion}, got ${newFirmwareVersion}`,
      });
      logger.warn(
        `[FirmwareUpdateService] Version mismatch after update: expected ${targetVersion}, got ${newFirmwareVersion}`
      );
    }
  }

  /**
   * Restore a previously saved config backup to the gateway.
   * Throws if the backup file does not exist or the CLI command fails.
   */
  async restoreBackup(gatewayIp: string, backupPath: string): Promise<void> {
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }

    const result = await this.runCliCommand('meshtastic', [
      '--host', gatewayIp,
      '--configure', backupPath,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Restore command failed with exit code ${result.exitCode}: ${result.stderr}`);
    }

    logger.info(`[FirmwareUpdateService] Config restored from ${backupPath} to ${gatewayIp}`);
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
  updateStatus(partial: Partial<UpdateStatus>): void {
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
