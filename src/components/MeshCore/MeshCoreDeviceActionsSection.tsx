/**
 * MeshCoreDeviceActionsSection — things done ON the radio, now: refresh the
 * contact list, send an advert, sweep for nearby nodes.
 *
 * These sat on the Settings tab among saved settings until the #5683
 * follow-up. They are actions on the device, so they live on Device
 * Configuration, in one group that is kept apart from the settings that are
 * saved. Nothing here is saved, and nothing here runs unless a button is
 * pressed: the component makes no request on mount.
 *
 * What each button sends is unchanged. It calls the same hook action as
 * before, so the route, the payload, the rate limiter, the receive-only gate
 * and the flood-advert confirmation are the ones it always had:
 *
 *   Refresh contacts   POST …/meshcore/contacts/refresh     `nodes:write`
 *   Zero-hop / Flood   POST …/meshcore/advert {mode}        `connection:write`, TX
 *   Discover ×3        POST …/meshcore/discover {mode}      `nodes:write`, TX
 *
 * Each control is gated on the grant ITS route checks, not on the grant that
 * opened the page: a viewer without it gets the button disabled, with the
 * reason as its tooltip.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DiscoveredNode, MeshCoreActions } from './hooks/useMeshCore';
import { useToast } from '../ToastContainer';
import { MeshCoreAdvertButtons } from './MeshCoreAdvertButtons';
import styles from './MeshCoreDeviceActionsSection.module.css';

type DiscoverMode = 'nearby' | 'repeaters' | 'sensors';

export interface MeshCoreDeviceActionsSectionProps {
  connected: boolean;
  loading: boolean;
  /** Active discovery is companion-only. */
  isCompanion: boolean;
  actions: Pick<MeshCoreActions, 'refreshContacts' | 'sendAdvert' | 'discoverNodes'>;
  /** Strict receive-only mode: every transmitting control is held. */
  receiveOnly?: boolean;
  /** `nodes:write` on this source: Refresh contacts and Discover. */
  canWriteNodes: boolean;
  /** `connection:write` on this source: the advert buttons. */
  canWriteConnection: boolean;
  /** Another radio sweep (region discovery) is running: hold Discover. */
  otherSweepRunning?: boolean;
  /** Told when a node sweep starts and ends, so the other sweep can hold too. */
  onSweepRunningChange?: (running: boolean) => void;
}

export const MeshCoreDeviceActionsSection: React.FC<MeshCoreDeviceActionsSectionProps> = ({
  connected,
  loading,
  isCompanion,
  actions,
  receiveOnly = false,
  canWriteNodes,
  canWriteConnection,
  otherSweepRunning = false,
  onSweepRunningChange,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  // Which discovery (if any) is running, so the buttons disable and the
  // active one reads "Discovering…".
  const [discovering, setDiscovering] = useState<DiscoverMode | null>(null);
  /**
   * Who answered the last sweep (#4516). Reset at the start of every run, so
   * the list always describes the most recent sweep.
   */
  const [discoveredNodes, setDiscoveredNodes] = useState<DiscoveredNode[] | null>(null);

  const receiveOnlyTooltip = receiveOnly
    ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.')
    : undefined;
  const needsNodesWrite = t(
    'meshcore.device_actions.needs_nodes_write',
    'This needs the Nodes write permission on this source.',
  );
  const needsConnectionWrite = t(
    'meshcore.device_actions.needs_connection_write',
    'This needs the Connection write permission on this source.',
  );

  const handleDiscover = async (mode: DiscoverMode) => {
    setDiscovering(mode);
    onSweepRunningChange?.(true);
    setDiscoveredNodes(null);
    try {
      const result = await actions.discoverNodes(mode);
      if (result) {
        setDiscoveredNodes(result.nodes);
        showToast(
          t('meshcore.discover.result', '{{returned}} contacts returned ({{new}} new)', {
            returned: result.returned,
            new: result.newCount,
          }),
          'success',
        );
      } else {
        showToast(t('meshcore.discover.failed', 'Discovery failed'), 'error');
      }
    } finally {
      setDiscovering(null);
      onSweepRunningChange?.(false);
    }
  };

  const discoverDisabled =
    !canWriteNodes || !connected || loading || discovering !== null || otherSweepRunning || receiveOnly;
  const discoverTitle = !canWriteNodes ? needsNodesWrite : receiveOnlyTooltip;
  const discoverButton = (mode: DiscoverMode, label: string) => (
    <button
      type="button"
      onClick={() => void handleDiscover(mode)}
      disabled={discoverDisabled}
      title={discoverTitle}
    >
      {discovering === mode ? t('meshcore.discover.running', 'Discovering…') : label}
    </button>
  );

  return (
    <div className={`form-section ${styles.group}`} id="meshcore-device-actions" data-testid="meshcore-device-actions">
      <h3>{t('meshcore.settings.actions', 'Device actions')}</h3>
      <p className="hint">
        {t(
          'meshcore.device_actions.group_hint',
          'These act on the radio when you press them. Nothing here is a saved setting.',
        )}
      </p>

      <div className={styles.action}>
        <h4 className={styles.actionTitle}>
          {t('meshcore.device_actions.contacts_and_adverts', 'Contacts and adverts')}
        </h4>
        <p className="hint">
          {t('meshcore.settings.actions_hint',
            'Refresh the contact list from the device, or announce this node. A zero-hop advert reaches nodes in direct radio range; a flood advert crosses the whole mesh and costs much more airtime.')}
        </p>
        <div className={styles.buttons}>
          <button
            type="button"
            onClick={() => void actions.refreshContacts()}
            disabled={!canWriteNodes || !connected || loading}
            title={!canWriteNodes ? needsNodesWrite : undefined}
          >
            {t('meshcore.refresh', 'Refresh contacts')}
          </button>
          <MeshCoreAdvertButtons
            onSend={(mode) => actions.sendAdvert(mode)}
            disabled={!canWriteConnection || !connected || loading || receiveOnly}
            disabledTitle={!canWriteConnection ? needsConnectionWrite : receiveOnlyTooltip}
          />
        </div>
      </div>

      {isCompanion && (
        <div className={styles.action}>
          <h4 className={styles.actionTitle}>{t('meshcore.discover.title', 'Discover nodes')}</h4>
          <p className="hint">
            {t('meshcore.discover.hint',
              'Ask nodes in direct radio range to announce themselves. Responders are added as contacts. ' +
              'Multi-hop nodes will not appear — discovery is zero-hop.')}
          </p>
          <div className={styles.buttons}>
            {discoverButton('nearby', t('meshcore.discover.nearby', 'Discover Nearby Nodes'))}
            {discoverButton('repeaters', t('meshcore.discover.repeaters', 'Discover Repeaters'))}
            {discoverButton('sensors', t('meshcore.discover.sensors', 'Discover Sensors'))}
          </div>

          {/* Who answered the last sweep (#4516). A discovery response carries
              only key + type + signal, so a name is present only for a node
              that has advertised or answered the ANON_REQ OWNER pass. */}
          {discoveredNodes && discoveredNodes.length > 0 && (
            <div className={styles.results}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{t('meshcore.discover.col_node', 'Node')}</th>
                    <th className={styles.mono}>{t('meshcore.discover.col_key', 'Key')}</th>
                    <th className={styles.number}>
                      {t('meshcore.contact_details.ping_zero_hop_snr_in', 'SNR here')}
                    </th>
                    <th className={styles.number}>
                      {t('meshcore.contact_details.ping_zero_hop_snr_out', 'SNR at node')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {discoveredNodes.map((node) => (
                    <tr key={node.publicKey}>
                      <td>
                        {node.name || (
                          <span className={styles.unnamed}>
                            {t('meshcore.discover.unnamed', 'Unknown')}
                          </span>
                        )}
                        {node.isNew && (
                          <span className={styles.newBadge}>
                            {t('meshcore.discover.new_badge', 'NEW')}
                          </span>
                        )}
                      </td>
                      <td className={styles.mono}>{node.publicKey.substring(0, 12)}…</td>
                      <td className={styles.number}>
                        {node.snr !== null ? `${node.snr.toFixed(2)} dB` : '—'}
                      </td>
                      <td className={styles.number}>
                        {node.snrToNode !== null ? `${node.snrToNode.toFixed(2)} dB` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MeshCoreDeviceActionsSection;
