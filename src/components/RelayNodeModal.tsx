import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { DeviceRole, isRelayRole } from '../constants';
import { getPortnumName } from '../utils/packetFormat';
import type { MeshMessage } from '../types/message';
import './RelayNodeModal.css';
import { UiIcon } from './icons';

interface Node {
  nodeNum: number;
  nodeId: string;
  longName: string;
  shortName: string;
  hopsAway?: number;
  role?: number;
  avgDirectRssi?: number;   // Average RSSI when heard directly (from zero-hop packets)
  heardDirectly?: boolean;  // Whether we've heard this node with 0 hops
}

interface RelayNodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  relayNode?: number;
  ackFromNode?: number;  // If provided, show this node instead of relay matches
  rxTime?: Date;
  nodes: Node[];
  onNodeClick: (nodeId: string) => void;
  messageRssi?: number;     // RSSI of the message being analyzed
  message?: MeshMessage;    // When provided, renders a full packet-detail section (#4657)
}

const RelayNodeModal: React.FC<RelayNodeModalProps> = ({
  isOpen,
  onClose,
  relayNode,
  ackFromNode,
  rxTime,
  nodes,
  onNodeClick,
  messageRssi,
  message,
}) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

  const isAckMode = ackFromNode !== undefined && ackFromNode !== null;
  const hasRelayNode = relayNode !== undefined && relayNode !== null;
  // Show the relay-candidate section whenever we have something to reason about:
  // an ack node, or a relay byte (0 included — "unknown relay" estimation mode).
  const showRelaySection = isAckMode || hasRelayNode;
  const isUnknownRelay = !isAckMode && relayNode === 0;

  /**
   * Sort nodes by likelihood of being the relay:
   * 1. Nodes heard directly first (heardDirectly === true)
   * 2. For directly heard nodes, sort by RSSI proximity to message RSSI
   * 3. For others, sort by hopsAway (ascending)
   */
  const sortByLikelihood = (nodeList: Node[]): Node[] => {
    return [...nodeList].sort((a, b) => {
      // Priority 1: Nodes heard directly come first
      const aHeard = a.heardDirectly === true;
      const bHeard = b.heardDirectly === true;

      if (aHeard && !bHeard) return -1;
      if (!aHeard && bHeard) return 1;

      // Priority 2: For directly heard nodes with RSSI data, sort by proximity to message RSSI
      if (aHeard && bHeard && messageRssi !== undefined) {
        const aRssiDiff = a.avgDirectRssi !== undefined ? Math.abs(a.avgDirectRssi - messageRssi) : Infinity;
        const bRssiDiff = b.avgDirectRssi !== undefined ? Math.abs(b.avgDirectRssi - messageRssi) : Infinity;
        if (aRssiDiff !== bRssiDiff) {
          return aRssiDiff - bRssiDiff;
        }
      }

      // Priority 3: Sort by hopsAway (ascending, closest first)
      return (a.hopsAway ?? Infinity) - (b.hopsAway ?? Infinity);
    });
  };

  // If ackFromNode is provided (and not null), show that specific node
  // Otherwise, try to match relay_node:
  //   1. If relay_node is 0 (unset), show all relay-capable nodes sorted by RSSI
  //   2. First try exact match (in case relay_node contains full node number)
  //   3. Fall back to matching lowest byte only
  // Filter out CLIENT_MUTE nodes since they don't relay
  // Sort results by likelihood
  const matchingNodes: Node[] = !showRelaySection
    ? []
    : isAckMode
    ? nodes.filter(node => node.nodeNum === ackFromNode)
    : (() => {
        // Filter out CLIENT_MUTE nodes - they don't relay
        const relayCapableNodes = nodes.filter(node => node.role !== DeviceRole.CLIENT_MUTE);

        // If relay_node is 0 (unset), show all relay-capable direct neighbors sorted by RSSI
        if (relayNode === 0) {
          // Only show nodes we've actually heard directly, sorted by RSSI proximity
          const directNeighbors = relayCapableNodes.filter(node => node.heardDirectly === true);
          return sortByLikelihood(directNeighbors);
        }

        // Try exact match first
        const exactMatches = relayCapableNodes.filter(node => node.nodeNum === relayNode);
        if (exactMatches.length > 0) {
          return sortByLikelihood(exactMatches);
        }

        // Fall back to byte matching
        // A relay MUST be a direct neighbor, so filter to only plausible candidates
        const byteMatches = relayCapableNodes.filter(node => (node.nodeNum & 0xFF) === relayNode);
        const plausibleRelays = byteMatches.filter(node =>
          node.heardDirectly === true || (node.hopsAway !== undefined && node.hopsAway <= 1)
        );
        return sortByLikelihood(plausibleRelays);
      })();

  const formatDateTime = (date?: Date) => {
    if (!date) return t('common.unknown');
    return date.toLocaleString();
  };

  const handleNodeClick = (nodeId: string) => {
    onNodeClick(nodeId);
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Modal title: packet-detail-only when a message is inspected without any
  // relay data (MQTT / direct); otherwise the existing relay/ack titles.
  const title = isAckMode
    ? t('relay_modal.title_ack')
    : hasRelayNode
    ? (isUnknownRelay ? t('relay_modal.title_unknown') : t('relay_modal.title_relay'))
    : t('relay_modal.title_packet');

  // ---- Packet detail rows (#4657) -----------------------------------------
  // Built only when a message is supplied. Each entry is rendered as a
  // label/value row; null values are dropped so we never show empty fields.
  const renderPacketDetails = () => {
    if (!message) return null;

    const rows: Array<{ label: string; value: React.ReactNode }> = [];

    // Received time
    rows.push({
      label: t('relay_modal.received'),
      value: formatDateTime(rxTime ?? message.timestamp),
    });

    // Message type (portnum)
    if (message.portnum !== undefined && message.portnum !== null) {
      rows.push({
        label: t('relay_modal.message_type'),
        value: `${getPortnumName(message.portnum)} (${message.portnum})`,
      });
    }

    // Packet ID — trailing segment of the composite message id
    // (`${sourceId}_${fromNum}_${packetId}`).
    const idTail = message.id?.split('_').pop();
    const packetId = idTail !== undefined ? Number(idTail) : NaN;
    if (Number.isFinite(packetId) && packetId > 0) {
      rows.push({
        label: t('relay_modal.packet_id'),
        value: `${packetId} (0x${packetId.toString(16).toUpperCase()})`,
      });
    }

    // Channel (-1 == direct message)
    if (message.channel !== undefined && message.channel !== null) {
      rows.push({
        label: t('relay_modal.channel'),
        value: message.channel === -1 ? t('relay_modal.channel_dm') : String(message.channel),
      });
    }

    // Hops
    if (message.hopStart !== undefined && message.hopLimit !== undefined) {
      const hopCount = message.hopStart - message.hopLimit;
      if (hopCount >= 0) {
        rows.push({
          label: t('relay_modal.hops'),
          value: `${hopCount} (${t('relay_modal.hop_start')} ${message.hopStart}, ${t('relay_modal.hop_limit')} ${message.hopLimit})`,
        });
      }
    }

    // Signal (direct-reception SNR/RSSI)
    if (message.rxSnr != null) {
      rows.push({ label: t('relay_modal.snr'), value: `${message.rxSnr.toFixed(2)} dB` });
    }
    if (message.rxRssi != null) {
      rows.push({ label: t('relay_modal.rssi'), value: `${message.rxRssi} dBm` });
    }

    // Relay node byte
    if (hasRelayNode && relayNode !== 0) {
      rows.push({
        label: t('relay_modal.relay_node_byte'),
        value: `0x${relayNode!.toString(16).padStart(2, '0').toUpperCase()}`,
      });
    }

    // Want ACK
    if (message.wantAck !== undefined) {
      rows.push({
        label: t('relay_modal.want_ack'),
        value: message.wantAck ? t('common.yes') : t('common.no'),
      });
    }

    // Delivery state
    if (message.deliveryState) {
      const deliveryLabels: Record<string, string> = {
        delivered: t('relay_modal.delivery_delivered'),
        confirmed: t('relay_modal.delivery_confirmed'),
        failed: t('relay_modal.delivery_failed'),
      };
      rows.push({
        label: t('relay_modal.delivery_state'),
        value: deliveryLabels[message.deliveryState] ?? message.deliveryState,
      });
    }

    // Reply-to
    if (message.replyId) {
      rows.push({ label: t('relay_modal.reply_to'), value: String(message.replyId) });
    }

    // Decrypted by
    if (message.decryptedBy) {
      rows.push({
        label: t('relay_modal.decrypted_by'),
        value: message.decryptedBy === 'server'
          ? t('relay_modal.decrypted_by_server')
          : t('relay_modal.decrypted_by_node'),
      });
    }

    // Ingress path
    if (message.sourcePath) {
      const ingressLabels: Record<string, string> = {
        http_api: t('relay_modal.ingress_http_api'),
        tcp_radio: t('relay_modal.ingress_tcp_radio'),
        mqtt_bridge: t('relay_modal.ingress_mqtt_bridge'),
        system: t('relay_modal.ingress_system'),
      };
      rows.push({
        label: t('relay_modal.ingress'),
        value: ingressLabels[message.sourcePath] ?? message.sourcePath,
      });
    }

    // Transport — explicit RF vs MQTT (the headline ask of #4657).
    const transportValue = message.viaMqtt
      ? t('relay_modal.transport_mqtt')
      : t('relay_modal.transport_rf');
    const transportIcon = message.viaMqtt ? 'network' : 'radio';

    return (
      <div className="packet-detail-section">
        <h3>{t('relay_modal.packet_details')}</h3>
        <div className="packet-detail-transport">
          <UiIcon name={transportIcon} size={18} />
          <span className="packet-detail-transport-label">{t('relay_modal.transport')}:</span>
          <span className="packet-detail-transport-value">{transportValue}</span>
          {message.viaStoreForward && (
            <span className="packet-detail-badge" title={t('relay_modal.store_forward')}>
              <UiIcon name="package" size={14} /> {t('relay_modal.store_forward')}
            </span>
          )}
        </div>
        <div className="packet-detail-fields">
          {rows.map(row => (
            <div className="packet-detail-row" key={row.label}>
              <span className="packet-detail-label">{row.label}:</span>
              <span className="packet-detail-value">{row.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const modalContent = (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div className="modal-content relay-node-modal">
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </div>
        <div className="modal-body">
          {renderPacketDetails()}

          {/* Legacy relay-info summary — shown only for the standalone relay/ack
              modal (no full message). When a message is supplied the packet
              detail section above already carries time + relay byte. */}
          {showRelaySection && !message && (
            <div className="relay-info-section">
              <div className="relay-info-row">
                <span className="relay-info-label">{t('relay_modal.acknowledged')}:</span>
                <span className="relay-info-value">{formatDateTime(rxTime)}</span>
              </div>
              {!isAckMode && !isUnknownRelay && (
                <div className="relay-info-row">
                  <span className="relay-info-label">{t('relay_modal.relay_node_byte')}:</span>
                  <span className="relay-info-value">0x{relayNode!.toString(16).padStart(2, '0').toUpperCase()}</span>
                </div>
              )}
            </div>
          )}

          {showRelaySection && (
            <div className="potential-relays-section">
              <h3>{isAckMode ? t('relay_modal.acknowledged_by') : isUnknownRelay ? t('relay_modal.estimated_relays') : t('relay_modal.potential_relays')}</h3>
              {isUnknownRelay && (
                <p className="unknown-relay-notice">
                  {t('relay_modal.unknown_relay_explanation')}
                </p>
              )}
              {matchingNodes.length === 0 ? (
                <p className="no-matches">
                  {isUnknownRelay ? t('relay_modal.no_direct_neighbors') : t('relay_modal.no_matches', { byte: `0x${relayNode!.toString(16).padStart(2, '0').toUpperCase()}` })}
                </p>
              ) : (
                <div className="relay-nodes-list">
                  {matchingNodes.map(node => (
                    <div
                      key={node.nodeId}
                      className={`relay-node-item ${!node.heardDirectly ? 'never-heard' : ''}`}
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
                      <div className="node-main-info">
                        <span className="node-name">
                          {node.heardDirectly && (
                            <span className="direct-indicator" title={t('relay_modal.heard_directly')}>
                              <UiIcon name="check" size={14} />
                            </span>
                          )}
                          {node.longName} ({node.shortName})
                          {isRelayRole(node.role) && (
                            <span className="relay-indicator" title={t('relay_modal.likely_relay')}>
                              <UiIcon name="repeater" size={14} />
                            </span>
                          )}
                        </span>
                        {node.avgDirectRssi !== undefined && (
                          <span className="node-rssi" title={t('relay_modal.avg_rssi')}>
                            {node.avgDirectRssi.toFixed(0)} dBm
                          </span>
                        )}
                      </div>
                      <div className="node-meta-info">
                        {node.hopsAway !== undefined && (
                          <span className="node-hops">
                            {node.hopsAway === 0
                              ? t('relay_modal.direct')
                              : t('relay_modal.hops_away', { count: node.hopsAway })}
                          </span>
                        )}
                        <span className="node-id">[{node.nodeId}]</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {matchingNodes.length > 1 && (
                <p className="multiple-matches-note">
                  {isUnknownRelay ? t('relay_modal.rssi_estimate_note') : t('relay_modal.multiple_matches_note')}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};

export default RelayNodeModal;
