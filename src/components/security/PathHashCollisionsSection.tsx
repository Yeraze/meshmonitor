import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { FindingNodeLink } from './FindingNodeLink';
import type { MeshcoreFindings, OpenNode } from './securityTypes';
import styles from './SecurityFindings.module.css';

interface Props {
  collisions: MeshcoreFindings['pathHashCollisions'];
  onOpenNode?: OpenNode;
}

const WIDTHS: Array<1 | 2 | 3> = [1, 2, 3];

/** Repeaters and rooms whose route hash matches at the source's path-hash width. */
export const PathHashCollisionsSection: React.FC<Props> = ({ collisions, onOpenNode }) => {
  const { t } = useTranslation();
  return (
    <section className={styles.section} data-testid="security-path-hash-collisions">
      <h3 className={styles.title}>
        <UiIcon name="route" size={16} />
        {t('security.mc_collisions_title', 'Path hash collisions')} ({collisions.groups.length})
      </h3>
      <p className={styles.description}>
        {t(
          'security.mc_collisions_description',
          'Repeaters that share the same route hash cannot be told apart in a path. Shown at this source\'s {{width}}-byte hash width.',
          { width: collisions.width },
        )}
      </p>
      <ul className={styles.counts}>
        {WIDTHS.map(w => (
          <li
            key={w}
            className={`${styles.countChip} ${(collisions.countsByWidth?.[w] ?? 0) > 0 ? styles.countChipActive : ''}`}
          >
            {t('security.mc_collisions_count_at_width', '{{width}}-byte: {{count}}', {
              width: w,
              count: collisions.countsByWidth?.[w] ?? 0,
            })}
          </li>
        ))}
      </ul>
      {collisions.groups.length === 0 ? (
        <p className={styles.empty}>{t('security.mc_collisions_empty', 'No collisions among recently heard repeaters.')}</p>
      ) : (
        <ul className={styles.groupList}>
          {collisions.groups.map(group => (
            <li key={group.hash} className={styles.group}>
              <p className={styles.groupHead}>
                {t('security.mc_collisions_hash', 'Hash')} <span className={styles.mono}>{group.hash}</span>
                {' '}({t('security.mc_collisions_nodes', '{{count}} repeaters', { count: group.nodes.length })})
              </p>
              <ul className={styles.nodeList}>
                {group.nodes.map(node => (
                  <li key={node.nodeKey} className={styles.nodeRow}>
                    <FindingNodeLink node={node} onOpenNode={onOpenNode} />
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
