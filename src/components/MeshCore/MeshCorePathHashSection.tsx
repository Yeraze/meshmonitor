/**
 * MeshCorePathHashSection — default path hash size (#4945), on Device
 * Configuration.
 *
 * The value is pushed to the companion's persistent NodePrefs
 * (CMD_SET_PATH_HASH_MODE), so it is device configuration. It sat on the
 * Settings tab until the #5683 follow-up. The read and the write are the ones
 * it always used: `GET` / `POST …/meshcore/config/default-path-hash-size`,
 * `{ size }`, which check `configuration:read` / `configuration:write` — the
 * grants this page already runs on.
 *
 * Saved by its own button, like every section of this page. The dropdown is a
 * draft: nothing is written to the device until Save is pressed.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreActions } from './hooks/useMeshCore';
import { useToast } from '../ToastContainer';
import { CollapsibleSection } from './CollapsibleSection';
import styles from './MeshCoreDeviceSettingSections.module.css';

type PathHashSize = 1 | 2 | 3;

export interface MeshCorePathHashSectionProps {
  connected: boolean;
  loading?: boolean;
  actions: Pick<MeshCoreActions, 'getDefaultPathHashSize' | 'setDefaultPathHashSize'>;
  /** `configuration:write` on this source. */
  canWriteConfig: boolean;
}

export const MeshCorePathHashSection: React.FC<MeshCorePathHashSectionProps> = ({
  connected,
  loading = false,
  actions,
  canWriteConfig,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { getDefaultPathHashSize, setDefaultPathHashSize } = actions;
  const [pathHashSize, setPathHashSizeState] = useState<PathHashSize>(1);
  // Draft selection; applied to the device only on an explicit Save so an
  // accidental dropdown change doesn't write persistent firmware state.
  const [pathHashInput, setPathHashInput] = useState<PathHashSize>(1);
  const [savingPathHash, setSavingPathHash] = useState(false);

  useEffect(() => {
    if (!connected) return;
    void getDefaultPathHashSize().then((s) => { setPathHashSizeState(s); setPathHashInput(s); });
  }, [connected, getDefaultPathHashSize]);

  const handleSave = async (size: PathHashSize) => {
    setSavingPathHash(true);
    try {
      const result = await setDefaultPathHashSize(size);
      if (result === null) {
        showToast(t('meshcore.path_hash.save_failed', 'Failed to save default path hash size'), 'error');
        return;
      }
      setPathHashSizeState(result);
      setPathHashInput(result);
      showToast(t('meshcore.path_hash.saved', 'Default path hash size saved'), 'success');
    } finally {
      setSavingPathHash(false);
    }
  };

  const disabled = !canWriteConfig || !connected || loading || savingPathHash;

  return (
    <CollapsibleSection title={t('meshcore.path_hash.title', 'Default path hash size')} className="form-section">
      <div id="meshcore-path-hash">
        <p className="hint">
          {t('meshcore.path_hash.hint',
            'Number of bytes used for path/loop-detection hashes on outgoing messages. ' +
            '1 byte (256 values) is enough for small meshes; 2 bytes (65,536 values) is recommended for ' +
            'mid-to-large deployments to avoid path-table collisions that drop packets on valid routes. ' +
            'Applied to the device immediately and re-asserted on reconnect.')}
        </p>
        <div className={styles.row}>
          <select
            value={pathHashInput}
            onChange={(e) => setPathHashInput(Number(e.target.value) as PathHashSize)}
            disabled={disabled}
            aria-label={t('meshcore.path_hash.title', 'Default path hash size')}
          >
            <option value={1}>{t('meshcore.path_hash.one', '1 byte')}</option>
            <option value={2}>{t('meshcore.path_hash.two', '2 bytes (recommended)')}</option>
            <option value={3}>{t('meshcore.path_hash.three', '3 bytes')}</option>
          </select>
          <button
            type="button"
            onClick={() => void handleSave(pathHashInput)}
            disabled={disabled || pathHashInput === pathHashSize}
            aria-label={t('meshcore.path_hash.save', 'Save path hash size')}
          >
            {savingPathHash ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
        </div>
      </div>
    </CollapsibleSection>
  );
};

export default MeshCorePathHashSection;
