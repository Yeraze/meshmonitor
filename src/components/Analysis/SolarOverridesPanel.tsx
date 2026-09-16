/**
 * Manual solar classification (#3195).
 *
 * The detector infers a panel from charge/discharge cycles. A node whose panel
 * and battery bank dwarf its load never dips, so it is never detected. This
 * panel lets an operator say what they already know: mark a node as solar, see
 * every node they have classified, and clear a classification to hand the node
 * back to auto-detection.
 *
 * Marking a node "not solar" happens on its report card instead; it then
 * disappears from the report, so it is listed here to keep it reversible.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import styles from './SolarOverridesPanel.module.css';

export interface SolarOverrideEntry {
  node_num: number;
  node_name: string;
  is_solar: boolean;
}

export interface SolarPickerNode {
  node_num: number;
  node_name: string;
}

export interface SolarOverridesPanelProps {
  overrides: SolarOverrideEntry[];
  /** Nodes with battery/voltage telemetry in the window — the only ones a flag can chart. */
  analyzedNodes: SolarPickerNode[];
  canWrite: boolean;
  busy: boolean;
  error: string | null;
  onSet: (nodeNum: number, isSolar: boolean | null) => void;
}

export function SolarOverridesPanel({
  overrides,
  analyzedNodes,
  canWrite,
  busy,
  error,
  onSet,
}: SolarOverridesPanelProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState('');

  const overridden = new Set(overrides.map((o) => o.node_num));
  const candidates = analyzedNodes.filter((n) => !overridden.has(n.node_num));

  if (!canWrite && overrides.length === 0) return null;

  return (
    <div className={styles.panel}>
      <div className={styles.title}>
        <UiIcon name="sun" size={15} />
        {t('analysis.solar_monitoring.overrides_title', 'Manual solar classification')}
      </div>
      <div className={styles.help}>
        {t(
          'analysis.solar_monitoring.overrides_help',
          "Detection looks for a daily charge and discharge cycle, so a node whose panel and battery far outsize its load can be missed. Mark it here. A manual classification applies to the node on every source and overrides detection until you clear it.",
        )}
      </div>

      {overrides.length > 0 && (
        <ul className={styles.list}>
          {overrides.map((o) => (
            <li key={o.node_num} className={styles.item}>
              <span className={styles.itemName}>{o.node_name}</span>
              <span className={styles.tag}>
                {o.is_solar
                  ? t('analysis.solar_monitoring.override_solar', 'Marked solar')
                  : t('analysis.solar_monitoring.override_not_solar', 'Marked not solar')}
              </span>
              {canWrite && (
                <button type="button" disabled={busy} onClick={() => onSet(o.node_num, null)}>
                  {t('analysis.solar_monitoring.override_clear', 'Use auto-detection')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <div className={styles.addRow}>
          <select
            className={styles.select}
            aria-label={t('analysis.solar_monitoring.override_pick', 'Node to mark as solar')}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy || candidates.length === 0}
          >
            <option value="">
              {candidates.length === 0
                ? t('analysis.solar_monitoring.override_none', 'No other nodes reported battery or voltage telemetry')
                : t('analysis.solar_monitoring.override_pick', 'Node to mark as solar')}
            </option>
            {candidates.map((n) => (
              <option key={n.node_num} value={String(n.node_num)}>
                {n.node_name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || selected === ''}
            onClick={() => {
              onSet(Number(selected), true);
              setSelected('');
            }}
          >
            {t('analysis.solar_monitoring.override_mark_solar', 'Mark as solar')}
          </button>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}

export default SolarOverridesPanel;
