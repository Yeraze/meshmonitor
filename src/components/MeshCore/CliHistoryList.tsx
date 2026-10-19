/**
 * CliHistoryList — rows of stored MeshCore CLI commands (#5892), shared by the
 * per-console History panel and the unified CLI activity view. Click a row to
 * show its reply or error.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { cliActorLabel, type CliHistoryEntry } from './cliHistoryApi';
import styles from './CliHistory.module.css';

interface CliHistoryListProps {
  entries: CliHistoryEntry[];
  /** Show the source column (unified view). */
  showSource?: boolean;
  /** Show the target column (unified view). */
  showTarget?: boolean;
  sourceNames?: Record<string, string>;
}

const OUTCOME_CLASS: Record<CliHistoryEntry['outcome'], string> = {
  ok: styles.outcomeOk,
  blocked: styles.outcomeBlocked,
  failed: styles.outcomeFailed,
  timeout: styles.outcomeFailed,
};

export const CliHistoryList: React.FC<CliHistoryListProps> = ({
  entries,
  showSource = false,
  showTarget = false,
  sourceNames = {},
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<number | null>(null);

  const outcomeLabel = (o: CliHistoryEntry['outcome']) => {
    switch (o) {
      case 'ok': return t('meshcore.cliHistory.outcome_ok', 'OK');
      case 'blocked': return t('meshcore.cliHistory.outcome_blocked', 'Blocked');
      case 'failed': return t('meshcore.cliHistory.outcome_failed', 'Failed');
      case 'timeout': return t('meshcore.cliHistory.outcome_timeout', 'Timed out');
    }
  };
  const targetLabel = (e: CliHistoryEntry) => {
    if (e.targetKind === 'local') return e.targetName ?? t('meshcore.cliHistory.target_local', 'Local node');
    return e.targetName ?? (e.targetPublicKey ? `${e.targetPublicKey.slice(0, 12)}…` : t('meshcore.cliHistory.target_remote', 'Remote node'));
  };
  const vnLabel = t('meshcore.cliHistory.vn_client', 'Virtual Node app');
  const unknownLabel = t('meshcore.cliHistory.unknown_user', 'Unknown');

  return (
    <ul className={styles.list}>
      {entries.map((e) => {
        const open = expanded === e.id;
        const detail = e.reply ?? e.error;
        return (
          <li key={e.id} className={styles.item}>
            <button
              type="button"
              className={styles.row}
              aria-expanded={open}
              onClick={() => setExpanded(open ? null : e.id)}
            >
              <UiIcon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
              <time className={styles.time} dateTime={new Date(e.timestamp).toISOString()}>
                {new Date(e.timestamp).toLocaleString()}
              </time>
              {showSource && <span className={styles.meta}>{sourceNames[e.sourceId] ?? e.sourceId}</span>}
              {showTarget && <span className={styles.meta}>{targetLabel(e)}</span>}
              <span className={styles.meta}>{cliActorLabel(e, vnLabel, unknownLabel)}</span>
              <code className={styles.command}>{e.command}</code>
              <span className={`${styles.outcome} ${OUTCOME_CLASS[e.outcome]}`}>{outcomeLabel(e.outcome)}</span>
            </button>
            {open && (
              <div className={styles.detail}>
                {e.error && e.reply && <p className={styles.detailError}>{e.error}</p>}
                <pre className={e.reply ? styles.reply : styles.detailError}>
                  {detail ?? t('meshcore.cliHistory.no_reply', '(no reply)')}
                </pre>
                {e.elapsedMs !== null && (
                  <p className={styles.detailMeta}>
                    {t('meshcore.cliHistory.elapsed', '{{ms}} ms', { ms: e.elapsedMs })}
                  </p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
};
