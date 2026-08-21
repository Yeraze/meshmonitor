/**
 * RelayCandidateList — the "who relayed this packet?" section, extracted from
 * the former RelayNodeModal so the unified MessageDetailsModal can render it
 * for received Meshtastic messages (#4816 follow-up).
 *
 * `relayByte` is only the last byte of the relaying node's nodeNum, so identity
 * is inherently ambiguous. This list therefore ranks *candidates* by likelihood
 * (heard-directly first, then RSSI proximity, then hopsAway) and never collapses
 * an ambiguous set to a single asserted node.
 *
 * Own CSS module (not the frozen RelayNodeModal.css global sheet).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { DeviceRole, isRelayRole } from '../../constants';
import { UiIcon } from '../icons';
import styles from './RelayCandidateList.module.css';

export interface RelayCandidateNode {
  nodeNum: number;
  nodeId: string;
  longName: string;
  shortName: string;
  hopsAway?: number;
  role?: number;
  avgDirectRssi?: number;
  heardDirectly?: boolean;
}

interface Props {
  relayNode?: number;
  /** If provided, show this ACKing node instead of relay-byte candidates. */
  ackFromNode?: number;
  nodes: RelayCandidateNode[];
  /** RSSI of the message, used to rank directly-heard candidates. */
  messageRssi?: number;
  onNodeClick: (nodeId: string) => void;
}

const RelayCandidateList: React.FC<Props> = ({
  relayNode,
  ackFromNode,
  nodes,
  messageRssi,
  onNodeClick,
}) => {
  const { t } = useTranslation();

  const isAckMode = ackFromNode !== undefined && ackFromNode !== null;
  const hasRelayNode = relayNode !== undefined && relayNode !== null;
  const showRelaySection = isAckMode || hasRelayNode;
  const isUnknownRelay = !isAckMode && relayNode === 0;

  const sortByLikelihood = (nodeList: RelayCandidateNode[]): RelayCandidateNode[] => {
    return [...nodeList].sort((a, b) => {
      const aHeard = a.heardDirectly === true;
      const bHeard = b.heardDirectly === true;
      if (aHeard && !bHeard) return -1;
      if (!aHeard && bHeard) return 1;
      if (aHeard && bHeard && messageRssi !== undefined) {
        const aRssiDiff = a.avgDirectRssi !== undefined ? Math.abs(a.avgDirectRssi - messageRssi) : Infinity;
        const bRssiDiff = b.avgDirectRssi !== undefined ? Math.abs(b.avgDirectRssi - messageRssi) : Infinity;
        if (aRssiDiff !== bRssiDiff) return aRssiDiff - bRssiDiff;
      }
      return (a.hopsAway ?? Infinity) - (b.hopsAway ?? Infinity);
    });
  };

  const matchingNodes: RelayCandidateNode[] = !showRelaySection
    ? []
    : isAckMode
    ? nodes.filter((node) => node.nodeNum === ackFromNode)
    : (() => {
        const relayCapableNodes = nodes.filter((node) => node.role !== DeviceRole.CLIENT_MUTE);
        if (relayNode === 0) {
          const directNeighbors = relayCapableNodes.filter((node) => node.heardDirectly === true);
          return sortByLikelihood(directNeighbors);
        }
        const exactMatches = relayCapableNodes.filter((node) => node.nodeNum === relayNode);
        if (exactMatches.length > 0) return sortByLikelihood(exactMatches);
        const byteMatches = relayCapableNodes.filter((node) => (node.nodeNum & 0xff) === relayNode);
        const plausibleRelays = byteMatches.filter(
          (node) => node.heardDirectly === true || (node.hopsAway !== undefined && node.hopsAway <= 1),
        );
        return sortByLikelihood(plausibleRelays);
      })();

  if (!showRelaySection) return null;

  const handleNodeClick = (nodeId: string) => onNodeClick(nodeId);

  return (
    <div className={styles.section}>
      <h5>
        {isAckMode
          ? t('relay_modal.acknowledged_by')
          : isUnknownRelay
          ? t('relay_modal.estimated_relays')
          : t('relay_modal.potential_relays')}
      </h5>
      {isUnknownRelay && (
        <p className={styles.notice}>{t('relay_modal.unknown_relay_explanation')}</p>
      )}
      {matchingNodes.length === 0 ? (
        <p className={styles.noMatches}>
          {isUnknownRelay
            ? t('relay_modal.no_direct_neighbors')
            : t('relay_modal.no_matches', { byte: `0x${relayNode!.toString(16).padStart(2, '0').toUpperCase()}` })}
        </p>
      ) : (
        <div className={styles.list}>
          {matchingNodes.map((node) => (
            <div
              key={node.nodeId}
              className={`${styles.item} ${!node.heardDirectly ? styles.neverHeard : ''}`}
              onClick={() => handleNodeClick(node.nodeId)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleNodeClick(node.nodeId);
                }
              }}
            >
              <div className={styles.mainInfo}>
                <span className={styles.nodeName}>
                  {node.heardDirectly && (
                    <span className={styles.directIndicator} title={t('relay_modal.heard_directly')}>
                      <UiIcon name="check" size={14} />
                    </span>
                  )}
                  {node.longName} ({node.shortName})
                  {isRelayRole(node.role) && (
                    <span className={styles.relayIndicator} title={t('relay_modal.likely_relay')}>
                      <UiIcon name="repeater" size={14} />
                    </span>
                  )}
                </span>
                {node.avgDirectRssi !== undefined && (
                  <span className={styles.nodeRssi} title={t('relay_modal.avg_rssi')}>
                    {node.avgDirectRssi.toFixed(0)} dBm
                  </span>
                )}
              </div>
              <div className={styles.metaInfo}>
                {node.hopsAway !== undefined && (
                  <span className={styles.nodeHops}>
                    {node.hopsAway === 0
                      ? t('relay_modal.direct')
                      : t('relay_modal.hops_away', { count: node.hopsAway })}
                  </span>
                )}
                <span className={styles.nodeId}>[{node.nodeId}]</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {matchingNodes.length > 1 && (
        <p className={styles.multipleNote}>
          {isUnknownRelay ? t('relay_modal.rssi_estimate_note') : t('relay_modal.multiple_matches_note')}
        </p>
      )}
    </div>
  );
};

export default RelayCandidateList;
