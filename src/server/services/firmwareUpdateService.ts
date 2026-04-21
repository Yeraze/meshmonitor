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
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import meshtasticManager from '../meshtasticManager.js';
import { dataEventEmitter } from './dataEventEmitter.js';
import {
  getBoardName,
  getPlatformForBoard,
  isOtaCapable,
  getHardwareDisplayName,
} from './firmwareHardwareMap.js';
// Re-export for consumers
export { getBoardName, getPlatformForBoard, isOtaCapable, getHardwareDisplayName };

const DEFAULT_MESHTASTIC_TCP_PORT = 4403;
// Port served by the MeshtasticOTA-WiFi loader in the ota_1 partition during OTA mode.
const OTA_LOADER_PORT = 3232;

function parseGateway(gateway: string): { host: string; port: number } {
  const trimmed = gateway.trim();
  // Support "host:port" but leave IPv6 literals alone — dev/prod only use IPv4 or hostnames.
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon > 0 && /^\d+$/.test(trimmed.slice(lastColon + 1))) {
    const port = Number(trimmed.slice(lastColon + 1));
    return { host: trimmed.slice(0, lastColon), port };
  }
  return { host: trimmed, port: DEFAULT_MESHTASTIC_TCP_PORT };
}

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
const DATA_DIR = process.env.DATA_DIR || '/data';
const BACKUP_DIR = path.join(DATA_DIR, 'firmware-backups');

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
    const stored = await databaseService.settings.getSetting('firmwareChannel');
    if (stored === 'alpha' || stored === 'stable' || stored === 'custom') {
      return stored;
    }
    return 'stable';
  }

  /**
   * Set the firmware channel.
   */
  async setChannel(channel: FirmwareChannel): Promise<void> {
    await databaseService.settings.setSetting('firmwareChannel', channel);
  }

  /**
   * Get the custom firmware URL, or null if not set.
   */
  async getCustomUrl(): Promise<string | null> {
    return await databaseService.settings.getSetting('firmwareCustomUrl');
  }

  /**
   * Set the custom firmware URL.
   */
  async setCustomUrl(url: string): Promise<void> {
    await databaseService.settings.setSetting('firmwareCustomUrl', url);
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

  /**
   * Complete a successful update: reset firmware state, then force a full
   * disconnect→reconnect so the node data is re-downloaded from scratch.
   * The UI will show the disconnected/reconnecting state.
   */
  async completeUpdate(): Promise<void> {
    this.cleanupTempDir();
    this.status = createIdleStatus();
    this.updateStatus({});
    logger.info('[FirmwareUpdateService] Update completed — initiating full reconnect cycle');

    // Force disconnect (clears intervals, transport, etc.)
    await meshtasticManager.userDisconnect();

    // Reset module-config cache so all configs are re-fetched on reconnect
    meshtasticManager.resetModuleConfigCache();

    // Reconnect from scratch — handleConnected() will request full node DB
    await meshtasticManager.userReconnect();
  }

  /**
   * Retry the flash step using already-downloaded firmware files.
   * Can only be called from error state when temp dir and matched file still exist.
   */
  retryFlash(): void {
    if (this.status.state !== 'error') {
      throw new Error('Can only retry from error state');
    }
    if (!this.tempDir || !this.status.matchedFile) {
      throw new Error(
        'Cannot retry: firmware files are no longer available. Please start a new update.'
      );
    }

    this.updateStatus({
      state: 'awaiting-confirm',
      step: 'flash',
      message: 'Ready to retry flash. Confirm to proceed.',
      error: undefined,
      logs: [],
    });

    logger.info('[FirmwareUpdateService] Retry flash requested — re-entering flash step');
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
    args: string[],
    options?: { onOutput?: (chunk: string) => void }
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
        logger.debug(`[FirmwareUpdateService] CLI stdout: ${text.trimEnd()}`);
        options?.onOutput?.(text);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        logger.debug(`[FirmwareUpdateService] CLI stderr: ${text.trimEnd()}`);
        options?.onOutput?.(text);
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

    // WiFi OTA requires firmware >= 2.7.18 on the running node
    const versionMatch = params.currentVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (versionMatch) {
      const [, major, minor, patch] = versionMatch.map(Number);
      const minVersion = [2, 7, 18];
      if (major < minVersion[0]
        || (major === minVersion[0] && minor < minVersion[1])
        || (major === minVersion[0] && minor === minVersion[1] && patch < minVersion[2])) {
        throw new Error(
          `WiFi OTA requires firmware >= 2.7.18 on the running node. ` +
          `Current version is ${params.currentVersion}. ` +
          `Please update manually via USB first.`
        );
      }
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
  /**
   * Disconnect MeshMonitor from the node so the CLI can use the TCP connection.
   * This is called before backup and stays disconnected through the entire flash process.
   */
  async disconnectFromNode(): Promise<void> {
    this.appendLog('Disconnecting from node...');
    this.updateStatus({
      state: 'in-progress',
      step: 'backup',
      message: 'Disconnecting from node for firmware update...',
    });
    logger.info('[FirmwareUpdateService] Disconnecting MeshMonitor from node for CLI access');
    await meshtasticManager.userDisconnect();
    this.appendLog('Disconnected from node.');
    logger.info('[FirmwareUpdateService] MeshMonitor disconnected from node');
  }

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
        const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
        logger.error(`[FirmwareUpdateService] Backup CLI failed (exit ${result.exitCode}): ${combined}`);
        throw new Error(`Backup command failed (exit code ${result.exitCode}). Check server logs for details.`);
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      // Sanitize nodeId: strip any characters that could escape BACKUP_DIR.
      const safeNodeId = String(nodeId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'unknown';
      const candidatePath = path.join(BACKUP_DIR, `config-${safeNodeId}-${timestamp}.yaml`);
      // Defense-in-depth: verify resolved path is still under BACKUP_DIR.
      const resolvedBackupDir = path.resolve(BACKUP_DIR);
      const backupPath = path.resolve(candidatePath);
      if (!backupPath.startsWith(resolvedBackupDir + path.sep)) {
        throw new Error('Refusing to write backup outside of backup directory');
      }
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
      // Reconnect on failure so MeshMonitor isn't left disconnected
      logger.info('[FirmwareUpdateService] Reconnecting MeshMonitor after backup failure');
      await meshtasticManager.userReconnect();
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
      const tempDir = fs.mkdtempSync(path.join(DATA_DIR, 'firmware-tmp-'));
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
      message: `Verifying ${gatewayIp} is ready for OTA...`,
      progress: 0,
    });

    const { host, port } = parseGateway(gatewayIp);
    try {
      await this.waitForNodeReady(host, port);
      this.appendLog(`Node ${host}:${port} is accepting connections — starting OTA.`);
    } catch (readyErr) {
      const message = readyErr instanceof Error ? readyErr.message : String(readyErr);
      this.updateStatus({
        state: 'error',
        step: 'flash',
        message: `Node not ready for OTA: ${message}`,
        error: message,
      });
      logger.error(`[FirmwareUpdateService] Readiness check failed before OTA: ${message}`);
      logger.info('[FirmwareUpdateService] Reconnecting MeshMonitor after readiness failure');
      await meshtasticManager.userReconnect();
      throw new Error(`Node readiness check failed: ${message}`);
    }

    this.updateStatus({
      state: 'in-progress',
      step: 'flash',
      message: `Flashing firmware to ${gatewayIp}...`,
      progress: 0,
    });

    const startTime = Date.now();
    let lastProgressUpdate = 0;

    try {
      // The meshtastic-python CLI triggers the admin reboot into OTA mode cleanly
      // but its built-in upload retry loop (fixed 5s sleep + 5 rapid attempts at
      // :3232) routinely misses the loader's short listen window on fast devices
      // like the Heltec V3 — by the time the CLI gives up, the loader has already
      // timed out and the device is back in normal firmware.
      //
      // To avoid that: we start the CLI (which sends the admin request) and, in
      // parallel, poll :3232 ourselves at 500ms intervals. As soon as the loader
      // opens its socket we terminate the CLI and upload the firmware directly
      // using the loader's documented protocol
      // ("OTA <size> <hex-sha256>\n" + payload + "OK" response).
      let cliExited = false;
      const cliPromise = this.runCliCommand('meshtastic', [
        '--host', gatewayIp,
        '--timeout', '30',
        '--ota-update', firmwarePath,
      ], {
        onOutput: (chunk: string) => {
          // Split on \r and \n — meshtastic CLI uses \r to overwrite progress lines in-place
          const lines = chunk.split(/[\r\n]+/).map(l => l.trimEnd()).filter(Boolean);
          for (const line of lines) {
            const progressMatch = line.match(/\((\d+(?:\.\d+)?)%\)/);
            if (progressMatch) {
              const pct = Math.round(parseFloat(progressMatch[1]));
              const now = Date.now();
              if (now - lastProgressUpdate >= 2000 || pct >= 100) {
                lastProgressUpdate = now;
                this.updateStatus({ progress: pct, message: `Uploading firmware: ${pct}%` });
              }
              continue;
            }
            this.appendLog(line);
          }
        },
      }).then(result => {
        cliExited = true;
        return result;
      });

      const loaderReadyPromise: Promise<boolean> = (async () => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline && !cliExited) {
          try {
            await this.probePort(host, OTA_LOADER_PORT, 1000);
            return true;
          } catch {
            await new Promise(r => setTimeout(r, 500));
          }
        }
        return false;
      })();

      const winner = await Promise.race([
        loaderReadyPromise.then(ready => ({ kind: 'loader' as const, ready })),
        cliPromise.then(result => ({ kind: 'cli' as const, result })),
      ]);

      if (winner.kind === 'loader' && winner.ready) {
        this.appendLog(`OTA loader is listening on ${host}:${OTA_LOADER_PORT} — taking over upload from CLI.`);
        logger.info(`[FirmwareUpdateService] Loader detected on ${host}:${OTA_LOADER_PORT}; terminating CLI and uploading directly`);
        if (this.activeProcess) {
          this.activeProcess.kill('SIGTERM');
        }
        // Give the CLI a moment to exit and release any half-open sockets.
        await Promise.race([
          cliPromise,
          new Promise(r => setTimeout(r, 3000)),
        ]);
        await this.uploadOtaFirmware(host, OTA_LOADER_PORT, firmwarePath);
      } else if (winner.kind === 'cli') {
        const result = winner.result;
        const elapsed = Date.now() - startTime;
        const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');

        if (result.exitCode === 0) {
          // CLI handled the whole flow on its own.
        } else {
          logger.error(`[FirmwareUpdateService] Flash via CLI failed (exit code ${result.exitCode}, ${Math.round(elapsed / 1000)}s): ${combined}`);
          // One last chance: the loader may have come up right as the CLI gave up.
          this.appendLog('CLI exited without completing the upload. Checking whether the OTA loader is still reachable...');
          let loaderReady = false;
          try {
            await this.waitForNodeReady(host, OTA_LOADER_PORT, 15_000);
            loaderReady = true;
          } catch { /* fall through */ }

          if (loaderReady) {
            this.appendLog(`OTA loader is listening on ${host}:${OTA_LOADER_PORT} — uploading firmware directly.`);
            await this.uploadOtaFirmware(host, OTA_LOADER_PORT, firmwarePath);
          } else if (/connection refused/i.test(combined)) {
            throw new Error(
              'The device entered OTA mode but rebooted back to normal firmware before the upload could start. ' +
              'This is a known timing race with the Meshtastic OTA loader on fast boards. Please retry the update.'
            );
          } else {
            throw new Error(`Flash command failed (exit code ${result.exitCode}). Check the update logs for details.`);
          }
        }
      } else {
        throw new Error(
          'The OTA loader never became reachable on ' + host + ':' + OTA_LOADER_PORT + '. ' +
          'This usually means the OTA bootloader has not been installed (it must be flashed once via USB). ' +
          'See the Firmware OTA Prerequisites documentation.'
        );
      }

      this.appendLog('Firmware flashed successfully. Waiting for node to reboot...');
      this.updateStatus({
        state: 'in-progress',
        step: 'flash',
        message: 'Firmware flashed successfully. Waiting for node to reboot...',
      });

      // The device just rebooted into new firmware — it takes ~10–30s to come
      // back on :4403. Reconnecting before the port is open triggers the TCP
      // transport's auto-reconnect loop which races with later reconnect calls
      // (e.g. from completeUpdate) and leaves the source in a "connected but
      // no config" limbo where handleConnected fires on a torn-down transport.
      // Poll the API port ourselves first, then reconnect synchronously once.
      const nodeHost = parseGateway(gatewayIp).host;
      logger.info('[FirmwareUpdateService] OTA flash completed — waiting for node to finish reboot before reconnecting');
      try {
        await this.waitForNodeReady(nodeHost, DEFAULT_MESHTASTIC_TCP_PORT, 120_000);
        this.appendLog('Node is back online. Reconnecting MeshMonitor...');
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        this.appendLog(`Node did not come back within 2 minutes (${m}). Reconnect will continue in the background.`);
        logger.warn(`[FirmwareUpdateService] Post-flash reboot wait timed out: ${m}`);
      }

      await meshtasticManager.userReconnect();
      this.appendLog('Reconnected to node.');

      this.updateStatus({
        state: 'awaiting-confirm',
        step: 'flash',
        message: 'Firmware flashed successfully. The node has been updated and reconnected.',
      });

      logger.info('[FirmwareUpdateService] OTA flash completed successfully and reconnected to node');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus({
        state: 'error',
        step: 'flash',
        message: `Flash failed: ${message}`,
        error: message,
      });
      // Reconnect on failure so MeshMonitor isn't left disconnected. Wait for
      // the node first — it may have been mid-reboot when the flash errored
      // out, and reconnecting into an ECONNREFUSED kicks off the auto-retry
      // race we're explicitly trying to avoid.
      logger.info('[FirmwareUpdateService] Reconnecting MeshMonitor after flash failure');
      try {
        await this.waitForNodeReady(parseGateway(gatewayIp).host, DEFAULT_MESHTASTIC_TCP_PORT, 30_000);
      } catch {
        // Best-effort — reconnect anyway and let the transport's retry handle it.
      }
      await meshtasticManager.userReconnect();
      throw error;
    } finally {
      // Only clean up temp dir on success — keep it for retry on failure
      if (this.status.state !== 'error') {
        this.cleanupTempDir();
      }
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
    // Restrict restorable paths to files inside BACKUP_DIR. Without this a
    // caller could pass an arbitrary path (e.g. /etc/passwd) and use the
    // existsSync check as a filesystem-probe oracle.
    const resolvedBackupDir = path.resolve(BACKUP_DIR);
    const resolvedBackup = path.resolve(backupPath);
    if (!resolvedBackup.startsWith(resolvedBackupDir + path.sep)) {
      throw new Error('Backup path is outside the allowed backup directory');
    }
    if (!fs.existsSync(resolvedBackup)) {
      throw new Error(`Backup file not found: ${resolvedBackup}`);
    }

    const result = await this.runCliCommand('meshtastic', [
      '--host', gatewayIp,
      '--configure', resolvedBackup,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Restore command failed with exit code ${result.exitCode}: ${result.stderr}`);
    }

    logger.info(`[FirmwareUpdateService] Config restored from ${backupPath} to ${gatewayIp}`);
  }

  // ---- Private helpers ----

  /**
   * Block until the node's API port accepts a new TCP connection, or throw.
   * Used before OTA to confirm MeshMonitor has fully released its socket and
   * the device is ready for the CLI to connect.
   */
  private async waitForNodeReady(host: string, port: number, timeoutMs: number = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    let lastError: string = 'unknown';
    while (Date.now() < deadline) {
      attempt++;
      try {
        await this.probePort(host, port, 2000);
        logger.debug(`[FirmwareUpdateService] Readiness probe OK for ${host}:${port} on attempt ${attempt}`);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.debug(`[FirmwareUpdateService] Readiness probe attempt ${attempt} failed for ${host}:${port}: ${lastError}`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    throw new Error(`${host}:${port} did not accept a TCP connection within ${Math.round(timeoutMs / 1000)}s (last error: ${lastError})`);
  }

  /**
   * Upload firmware directly to the MeshtasticOTA-WiFi loader on :3232.
   *
   * Protocol (matches meshtastic-python `ota.py ESP32WiFiOTA.update`):
   *   1. Client → loader: `OTA <size> <hex-sha256>\n`
   *   2. Loader → client: line-delimited status lines. May send `ERASING` first
   *      while it wipes the OTA partition (several seconds). Client must wait
   *      for a line whose stripped value is literally `OK` before streaming.
   *      Any `ERR <reason>` line aborts.
   *   3. Client → loader: raw firmware bytes in 1024-byte chunks, no framing.
   *   4. Loader → client: after it hashes the received image, sends a second
   *      literal `OK` on success (or `ERR <reason>`). Intermediate `ACK` lines
   *      are logged and ignored. Only AFTER this second `OK` does the loader
   *      commit + reboot.
   *   5. Client closes the socket.
   *
   * Critical: substring-matching "OK" is wrong — the first `OK` must be a
   * full line. Exiting after the first `OK` (before the second) leaves the
   * device stranded in OTA loader mode.
   */
  private uploadOtaFirmware(host: string, port: number, firmwarePath: string): Promise<void> {
    const fileBuffer = fs.readFileSync(firmwarePath);
    const size = fileBuffer.length;
    const sha256 = createHash('sha256').update(fileBuffer).digest('hex');
    const header = `OTA ${size} ${sha256}\n`;

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const OVERALL_TIMEOUT_MS = 5 * 60 * 1000;
      const CHUNK_SIZE = 1024;

      type Phase = 'handshake' | 'streaming' | 'commit' | 'done';
      let phase: Phase = 'handshake';
      let lineBuffer = '';
      let bytesSent = 0;
      let lastProgressUpdate = 0;
      let finished = false;

      const finish = (err?: Error) => {
        if (finished) return;
        finished = true;
        phase = 'done';
        clearTimeout(overallTimer);
        socket.removeAllListeners();
        socket.destroy();
        if (err) reject(err); else resolve();
      };

      const overallTimer = setTimeout(() => {
        finish(new Error(`Direct OTA upload timed out after ${OVERALL_TIMEOUT_MS / 1000}s (phase: ${phase})`));
      }, OVERALL_TIMEOUT_MS);

      const streamFirmware = () => {
        phase = 'streaming';
        this.updateStatus({ progress: 0, message: 'Uploading firmware: 0%' });
        let offset = 0;
        const writeNext = () => {
          while (offset < size) {
            if (finished) return;
            const end = Math.min(offset + CHUNK_SIZE, size);
            const chunk = fileBuffer.subarray(offset, end);
            const okToContinue = socket.write(chunk);
            offset = end;
            bytesSent = offset;

            const pct = Math.round((bytesSent / size) * 100);
            const now = Date.now();
            if (now - lastProgressUpdate >= 2000 || pct >= 100) {
              lastProgressUpdate = now;
              this.updateStatus({ progress: pct, message: `Uploading firmware: ${pct}%` });
            }

            if (!okToContinue) {
              socket.once('drain', writeNext);
              return;
            }
          }
          // All bytes written. Now wait for the commit `OK`.
          phase = 'commit';
          this.updateStatus({ progress: 100, message: 'Waiting for loader to verify and commit firmware...' });
          logger.debug(`[FirmwareUpdateService] Direct OTA: all ${size} bytes sent, awaiting commit OK`);
        };
        writeNext();
      };

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (trimmed === '') return;
        logger.debug(`[FirmwareUpdateService] Loader → ${trimmed} (phase=${phase})`);
        if (trimmed.startsWith('ERR')) {
          finish(new Error(`Loader reported error (phase=${phase}): ${trimmed}`));
          return;
        }
        if (phase === 'handshake') {
          if (trimmed === 'OK') {
            logger.info('[FirmwareUpdateService] Loader accepted header, streaming firmware...');
            streamFirmware();
          } else if (trimmed === 'ERASING') {
            this.updateStatus({ message: 'Loader erasing OTA partition...' });
          }
          // Any other line: ignore and keep waiting.
          return;
        }
        if (phase === 'commit') {
          if (trimmed === 'OK') {
            logger.info('[FirmwareUpdateService] Loader confirmed commit — firmware accepted');
            finish();
          } else if (trimmed === 'ACK') {
            // Per-chunk ACKs are advisory; ignore.
          }
          return;
        }
        // `streaming` / `done`: unexpected traffic, ignore.
      };

      socket.once('error', (err) => finish(err));
      socket.once('close', () => {
        if (finished) return;
        finish(new Error(`Loader closed connection in phase "${phase}" before commit OK (last line buffer: "${lineBuffer.trim()}")`));
      });

      socket.on('data', (data: Buffer) => {
        lineBuffer += data.toString('utf8');
        let nl = lineBuffer.indexOf('\n');
        while (nl !== -1 && !finished) {
          const line = lineBuffer.slice(0, nl);
          lineBuffer = lineBuffer.slice(nl + 1);
          handleLine(line);
          nl = lineBuffer.indexOf('\n');
        }
      });

      socket.once('connect', () => {
        logger.debug(`[FirmwareUpdateService] Direct OTA connected to ${host}:${port} (size=${size}, sha256=${sha256})`);
        this.updateStatus({ message: 'Sending OTA header to loader...' });
        socket.write(header);
      });

      socket.connect(port, host);
    });
  }

  private probePort(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`TCP probe timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        cleanup();
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        cleanup();
        reject(err);
      });
      socket.connect(port, host);
    });
  }

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
    if (this.status.logs.length >= 1000) {
      this.status.logs = this.status.logs.slice(-500);
    }
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
