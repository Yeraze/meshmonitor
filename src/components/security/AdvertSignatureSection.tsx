import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { FindingNodeLink } from './FindingNodeLink';
import type { FindingNode, OpenNode } from './securityTypes';
import styles from './SecurityFindings.module.css';

interface Props {
  failures: FindingNode[];
  onOpenNode?: OpenNode;
}

/** Contacts whose advert signature failed verification (never-checked ones are not listed). */
export const AdvertSignatureSection: React.FC<Props> = ({ failures, onOpenNode }) => {
  const { t } = useTranslation();
  return (
    <section className={styles.section} data-testid="security-advert-signatures">
      <h3 className={styles.title}>
        <UiIcon name="securityAlert" size={16} />
        {t('security.mc_signature_title', 'Advert signature failures')} ({failures.length})
      </h3>
      <p className={styles.description}>
        {t(
          'security.mc_signature_description',
          'These contacts sent an advert whose signature did not match its key. The advert may be forged. Adverts that were not checked are not listed.',
        )}
      </p>
      {failures.length === 0 ? (
        <p className={styles.empty}>{t('security.mc_signature_empty', 'No failed signatures.')}</p>
      ) : (
        <ul className={styles.nodeList}>
          {failures.map(node => (
            <li key={node.nodeKey} className={styles.nodeRow}>
              <FindingNodeLink node={node} onOpenNode={onOpenNode} />
              <span className={styles.badgeFailed}>{t('security.mc_signature_failed', 'Failed')}</span>
              {node.lastHeard ? (
                <span className={styles.meta}>{new Date(node.lastHeard).toLocaleString()}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
