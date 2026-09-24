/**
 * One muted, visible caption line marking a chart or stat as a firmware
 * device counter that cannot be split by transport (#5101 Phase 3, D4).
 * Deliberately not tooltip-only: phones cannot hover. Kept to a single
 * default export so `react-refresh/only-export-components` stays clean.
 */

import styles from './DeviceCounterNote.module.css';

export interface DeviceCounterNoteProps {
  text: string;
  testId?: string;
}

export default function DeviceCounterNote({ text, testId }: DeviceCounterNoteProps) {
  return (
    <p className={styles.note} data-testid={testId}>
      {text}
    </p>
  );
}
