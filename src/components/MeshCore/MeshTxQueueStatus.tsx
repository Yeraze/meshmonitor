/**
 * MeshTxQueueStatus (#6493)
 *
 * Status line for a manual MeshCore action that waits for the next radio slot:
 * "Queued — sending in N s", "Sending…", "Replaced by your newer request",
 * a 429 cooldown, and a "Replaces your queued …" note on the newer action.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { UseMeshTxQueuedAction } from './hooks/useMeshTxQueuedAction';
import type { MeshTxPhase } from './hooks/meshTxQueueStore';
import styles from './MeshTxQueueStatus.module.css';

type Props = Pick<UseMeshTxQueuedAction, 'phase' | 'secondsLeft' | 'position' | 'replaced'> & {
  /** Names the action that replaced a superseded one, when the server said. */
  supersededAction?: string | null;
};

const ACTIVE: ReadonlySet<MeshTxPhase> = new Set<MeshTxPhase>(['queued', 'sending', 'superseded', 'cooldown']);

export const MeshTxQueueStatus: React.FC<Props> = ({ phase, secondsLeft, position, replaced, supersededAction }) => {
  const { t } = useTranslation();
  if (!ACTIVE.has(phase)) return null;

  let text: string;
  let icon: 'timer' | 'send' | 'alert' = 'timer';
  if (phase === 'queued') {
    const ahead = Math.max(0, (position ?? 1) - 1);
    text = secondsLeft !== null
      ? t('meshcore.tx_queue.queued', 'Queued — sending in {{n}} s', { n: secondsLeft })
      : t('meshcore.tx_queue.queued_unknown', 'Queued — waiting for the radio');
    if (ahead > 0) text += ` · ${t('meshcore.tx_queue.ahead', '{{n}} ahead', { n: ahead })}`;
  } else if (phase === 'sending') {
    text = t('meshcore.tx_queue.sending', 'Sending…');
    icon = 'send';
  } else if (phase === 'superseded') {
    text = supersededAction
      ? t('meshcore.tx_queue.superseded_by', 'Replaced by your newer request ({{action}})', { action: supersededAction })
      : t('meshcore.tx_queue.superseded', 'Replaced by your newer request');
    icon = 'alert';
  } else {
    text = t('meshcore.tx_queue.cooldown', 'The radio queue is busy. Try again in {{n}} s', { n: secondsLeft ?? 0 });
    icon = 'alert';
  }

  return (
    <>
      <div className={`${styles.status} ${styles[phase]}`} role="status" aria-live="polite" data-testid="mesh-tx-queue-status">
        <UiIcon name={icon} size={16} className={styles.icon} />
        <span>{text}</span>
      </div>
      {replaced && phase !== 'superseded' && (
        <div className={`${styles.status} ${styles.replaces}`} data-testid="mesh-tx-queue-replaces">
          <span>
            {t('meshcore.tx_queue.replaces', 'Replaces your queued {{action}} for {{node}}', {
              action: replaced.label,
              node: `${replaced.publicKey.slice(0, 8)}…`,
            })}
          </span>
        </div>
      )}
    </>
  );
};
