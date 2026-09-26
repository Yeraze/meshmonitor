/**
 * Compact per-source hop-count badge for the Unified Messages feed (#5366).
 *
 * The issue asked for number emoji (keycap digits). Per the UiIcon rule in
 * CLAUDE.md, app-owned UI does not hardcode emoji, so this renders a styled
 * numeric pill instead. It also covers counts of 10+, where no keycap emoji
 * exists, and shows "?" when the hop count is unknown.
 */
import { useTranslation } from 'react-i18next';
import { hopDisplay, receptionHopCount, type ReceptionHopFields } from '../../pages/unifiedHops';
import styles from './HopBadge.module.css';

export interface HopBadgeProps {
  reception: ReceptionHopFields;
  sourceName: string;
}

export default function HopBadge({ reception, sourceName }: HopBadgeProps) {
  const { t } = useTranslation();
  const hops = receptionHopCount(reception);
  const label =
    hops != null
      ? t('unified.messages.hop_badge_label', { name: sourceName, hops: hopDisplay(reception, t) })
      : t('unified.messages.hop_badge_unknown', { name: sourceName });
  return (
    <span
      className={hops != null ? styles.badge : `${styles.badge} ${styles.unknown}`}
      title={label}
      aria-label={label}
      role="img"
      data-testid="unified-hop-badge"
    >
      {hops != null ? hops : '?'}
    </span>
  );
}
