import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { FindingNodeLink } from './FindingNodeLink';
import type { NameReuseGroup, OpenNode } from './securityTypes';
import styles from './SecurityFindings.module.css';

interface Props {
  groups: NameReuseGroup[];
  onOpenNode?: OpenNode;
}

/** The same name under more than one key. Display only: it never alerts. */
export const NameReuseSection: React.FC<Props> = ({ groups, onOpenNode }) => {
  const { t } = useTranslation();
  return (
    <section className={styles.section} data-testid="security-name-reuse">
      <h3 className={styles.title}>
        <UiIcon name="users" size={16} />
        {t('security.mc_name_reuse_title', 'Name reuse')} ({groups.length})
      </h3>
      <p className={styles.description}>
        {t(
          'security.mc_name_reuse_description',
          'A name that appears under more than one key. The first key heard is the likely original; later keys may be impersonating it. Names that look alike, or differ only in case, count as the same.',
        )}
      </p>
      {groups.length === 0 ? (
        <p className={styles.empty}>{t('security.mc_name_reuse_empty', 'No reused names.')}</p>
      ) : (
        <ul className={styles.groupList}>
          {groups.map(group => (
            <li key={`${group.name.toLowerCase()}`} className={styles.group}>
              <p className={styles.groupHead}>{group.name}</p>
              <ul className={styles.nodeList}>
                <li className={styles.nodeRow}>
                  <FindingNodeLink node={group.original} onOpenNode={onOpenNode} />
                  <span className={styles.original}>{t('security.mc_name_reuse_original', 'First heard')}</span>
                </li>
                {group.suspects.map(node => (
                  <li key={node.nodeKey} className={styles.nodeRow}>
                    <FindingNodeLink node={node} onOpenNode={onOpenNode} />
                    <span className={styles.badgeFailed}>{t('security.mc_name_reuse_suspect', 'Later key')}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
