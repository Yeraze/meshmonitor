/**
 * Protocol adapter seam for device-config backups (#6285).
 *
 * One pipeline (`deviceConfigBackupService`) serves every protocol; an adapter
 * knows how to read a device into YAML, recognise its own YAML, summarise it
 * without secrets, and write it back.
 */
import type { BackupProtocol } from '../../../db/repositories/backupHistory.js';

export type { BackupProtocol };

/** No secrets: safe to show in a confirm dialog. */
export interface BackupSummary {
  protocol: BackupProtocol;
  /** Node / owner name. */
  name?: string;
  /** Short key identity (public-key prefix), never a private key. */
  identity?: string;
  createdAt?: string;
  /** Radio parameters, as display strings keyed by label. */
  radio?: Record<string, string | number>;
  /** The connected radio's current parameters, when known (for a current -> backup comparison). */
  currentRadio?: Record<string, string | number>;
  /** True when `currentRadio` and `radio` differ: restoring changes the radio at once. */
  radioDiffers?: boolean;
  /** Channel slots the restore will overwrite. Names only, never PSKs. */
  channels: Array<{ idx: number; name: string }>;
  /** Sections the file holds, for the dialog. */
  sections: string[];
  /** MeshCore only: the file's key differs from the connected radio's. */
  identityMismatch?: boolean;
  /** The restore may reboot the device or needs one to fully apply. */
  requiresReboot: boolean;
}

export interface RestoreResult {
  applied: string[];
  failed: Array<{ section: string; error: string }>;
  /** Sections left out on purpose (not applicable, out of range, refused). */
  skipped?: Array<{ section: string; reason: string }>;
  channels: number;
  requiresReboot: boolean;
  identityMismatch?: boolean;
}

export interface DeviceConfigBackupAdapter<M = unknown, D = unknown> {
  protocol: BackupProtocol;
  /** Filename tag: `mt` or `mc`. */
  fileTag: 'mt' | 'mc';
  restoreTimeoutMs: number;
  /** Node id for the filename and the history row. */
  identify(manager: M): { nodeId: string; nodeNum: number | null };
  /** Read the device into YAML. Must never log the YAML. */
  generate(manager: M, sourceId: string): Promise<string>;
  /** Parse and validate; throws `BackupProtocolMismatchError` for another protocol's file. */
  parse(yaml: string): D;
  summarize(doc: D, manager?: M): BackupSummary;
  restore(manager: M, doc: D, sourceId: string): Promise<RestoreResult>;
}

/** The file is not a backup of this protocol (HTTP 409 BACKUP_PROTOCOL_MISMATCH). */
export class BackupProtocolMismatchError extends Error {
  constructor(message = 'This backup file belongs to a different device type') {
    super(message);
    this.name = 'BackupProtocolMismatchError';
  }
}
