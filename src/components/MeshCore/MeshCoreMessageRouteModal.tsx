/**
 * MeshCoreMessageRouteModal — shown when the relay-hash chain on a received
 * MeshCore message is clicked. Presents the message's reception details and
 * expands each relay hash to the matching repeater / room-server name from
 * the contact list (mirroring the {ROUTE_NAMES} automation token): only
 * relay infrastructure ever appears in a path, unknown hashes stay raw, and
 * hash collisions resolve to the candidate nearest the neighbouring hops.
 * Reuses the packet-monitor modal styling (mcpm-*).
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshCoreMessage } from './hooks/useMeshCore';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';
import {
  parsePathHops,
  pathHashBytesOf,
  repeaterHopOptions,
  resolveRouteNames,
} from '../../utils/meshcorePath';
import { UiIcon } from '../icons';
import './MeshCorePacketMonitor.css';

interface Props {
  message: MeshCoreMessage;
  /** Sender label already resolved by the stream (name or key prefix). */
  fromLabel: string;
  contacts: MeshCoreContact[];
  onClose: () => void;
}

const Row: React.FC<{ label: string; children: React.ReactNode; mono?: boolean; wrap?: boolean }> = ({ label, children, mono, wrap }) => (
  <div className="mcpm-dl-row">
    <span className="mcpm-dl-label">{label}</span>
    <span className={`mcpm-dl-value${mono ? ' mcpm-mono' : ''}${wrap ? ' mcpm-dl-wrap' : ''}`}>{children}</span>
  </div>
);

const MeshCoreMessageRouteModal: React.FC<Props> = ({ message, fromLabel, contacts, onClose }) => {
  const { t } = useTranslation();

  const hops = useMemo(() => parsePathHops(message.routePath), [message.routePath]);
  const width = pathHashBytesOf(hops);
  const rows = useMemo(() => {
    const names = resolveRouteNames(hops, contacts);
    const options = repeaterHopOptions(contacts, width);
    return hops.map((hash, i) => ({
      hash,
      name: names[i],
      matchCount: options.filter((o) => o.hopByte === hash).length,
    }));
  }, [hops, contacts, width]);

  const scopeStr = message.scopeName
    ? message.scopeName
    : typeof message.scopeCode === 'number' && message.scopeCode !== 0
      ? `#${message.scopeCode.toString(16).padStart(4, '0')}`
      : '—';

  return (
    <div className="mcpm-modal" onClick={onClose}>
      <div className="mcpm-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="mcpm-modal-header">
          <h4>{t('meshcore.route_detail_title', 'Message Route')}</h4>
          <button className="mcpm-modal-close" onClick={onClose} aria-label={t('common.close', 'Close')}>×</button>
        </div>

        <div className="mcpm-modal-body">
          <section className="mcpm-dl-section">
            <h5>{t('meshcore.route_detail_message', 'Message')}</h5>
            <Row label={t('meshcore.route_detail_from', 'From')}>{fromLabel}</Row>
            <Row label={t('meshcore.route_detail_time', 'Time')} mono>{new Date(message.timestamp).toLocaleString()}</Row>
            <Row label={t('meshcore.route_detail_hops', 'Hops')} mono>{typeof message.hopCount === 'number' ? message.hopCount : '—'}</Row>
            <Row label={t('meshcore.route_detail_scope', 'Scope')}>{scopeStr}</Row>
            {message.text && (
              <Row label={t('meshcore.route_detail_text', 'Text')} wrap>{message.text}</Row>
            )}
          </section>

          <section className="mcpm-dl-section">
            <h5>{t('meshcore.route_detail_route', 'Route')}</h5>
            <Row label={t('meshcore.packets.hashWidth', 'Hash width')} mono>{width} B</Row>
            {rows.length === 0 ? (
              <Row label={t('meshcore.packets.routing', 'Routing')}>{t('meshcore.packets.directNoRelay', 'Direct (no relays)')}</Row>
            ) : (
              <>
                {rows.map((r, i) => (
                  <Row key={`${r.hash}-${i}`} label={`#${i + 1}`} mono>
                    {r.hash}
                    {' '}<UiIcon name="forward" size={12} />{' '}
                    {r.matchCount === 0
                      ? t('meshcore.route_detail_unknown', 'unknown repeater')
                      : r.name}
                    {r.matchCount > 1 && (
                      <span className="mc-route-best-guess">
                        {' '}({t('meshcore.route_detail_best_guess', 'best guess of')} {r.matchCount} {t('meshcore.route_detail_matches', 'matches')})
                      </span>
                    )}
                  </Row>
                ))}
                <Row label={t('meshcore.route_detail_resolved', 'Resolved')} wrap>
                  <span className="mc-route-resolved">
                    {rows.map((r, i) => (
                      <React.Fragment key={`${r.hash}-${i}`}>
                        {r.matchCount === 0 ? r.hash : r.name}
                        {i < rows.length - 1 && <> <UiIcon name="forward" size={12} /> </>}
                      </React.Fragment>
                    ))}
                  </span>
                </Row>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default MeshCoreMessageRouteModal;
