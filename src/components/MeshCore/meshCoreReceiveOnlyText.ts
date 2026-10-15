import type { TFunction } from 'i18next';

/**
 * MeshCore's wording for the shared receive-only paused note (#4547, #5807).
 * Kept in one place so `MeshCoreReceiveOnlyNote` and the MeshCore automation
 * sections (which pass it to `ConfigSection`'s `receiveOnlyNote`) never drift.
 */
export const meshCoreReceiveOnlyText = (t: TFunction): string =>
  t(
    'meshcore.receive_only.paused_note',
    'Paused — receive-only mode. These settings are saved and unchanged; they take effect again when receive-only is turned off.',
  );
