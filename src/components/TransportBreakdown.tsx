import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from './TransportBreakdown.module.css';

/**
 * Inline "RF n · UDP n · MQTT n" summary line (#5101). Used twice in
 * InfoTab: the node "Heard via" breakdown (RF/UDP/MQTT, additive) and the
 * message transport split (RF/MQTT only, Phase 1 has no message UDP axis).
 * `counts.udp` is omitted from the rendered line when it is `undefined`
 * rather than rendered as 0, so callers without a UDP figure don't imply one.
 */
export interface TransportBreakdownProps {
  counts: { rf: number; udp?: number; mqtt: number };
  /** Optional leading label, e.g. "Heard via". */
  label?: string;
  /** Optional muted note rendered on its own line below the counts. */
  note?: string;
  testId?: string;
}

export default function TransportBreakdown({ counts, label, note, testId }: TransportBreakdownProps): React.ReactElement {
  const { t } = useTranslation();

  const parts = [`${t('transport.rf')} ${counts.rf}`];
  if (counts.udp !== undefined) {
    parts.push(`${t('transport.udp')} ${counts.udp}`);
  }
  parts.push(`${t('transport.mqtt')} ${counts.mqtt}`);

  return (
    <div className={styles.breakdown} data-testid={testId}>
      <span className={styles.line}>
        {label && <span className={styles.label}>{label} </span>}
        {parts.join(' · ')}
      </span>
      {note && <span className={styles.note}>{note}</span>}
    </div>
  );
}
