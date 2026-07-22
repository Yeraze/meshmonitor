/**
 * MeshCorePacketDetailModal — best-effort decode of a captured MeshCore OTA
 * packet, shown when a row in the MeshCore Packet Monitor is clicked. The
 * MeshCore analogue of the Meshtastic packet-detail modal: it parses the raw
 * hex with `decodeMeshCorePacket` and lays out the header, path, and (where
 * unencrypted) the payload contents.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshCoreOtaPacketEvent } from '../../hooks/useWebSocket';
import { decodeMeshCorePacket } from '../../utils/meshcorePacketDecode';
import { useDialogA11y } from '../../hooks/useDialogA11y';
import { UiIcon } from '../icons';

interface Props {
  packet: MeshCoreOtaPacketEvent;
  onClose: () => void;
}

const Row: React.FC<{ label: string; children: React.ReactNode; mono?: boolean; wrap?: boolean }> = ({ label, children, mono, wrap }) => (
  <div className="mcpm-dl-row">
    <span className="mcpm-dl-label">{label}</span>
    <span className={`mcpm-dl-value${mono ? ' mcpm-mono' : ''}${wrap ? ' mcpm-dl-wrap' : ''}`}>{children}</span>
  </div>
);

const fmtHex = (n: number) => `0x${n.toString(16).padStart(2, '0')}`;

const MeshCorePacketDetailModal: React.FC<Props> = ({ packet, onClose }) => {
  const { t } = useTranslation();
  const { contentRef, onKeyDown } = useDialogA11y(onClose);
  const decoded = decodeMeshCorePacket(packet.rawHex);

  const time = new Date(packet.timestamp);

  return (
    <div className="mcpm-modal" onClick={onClose} role="presentation">
      <div
        className="mcpm-modal-content"
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('meshcore.packets.detailTitle', 'Packet Decode')}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mcpm-modal-header">
          <h4>{t('meshcore.packets.detailTitle', 'Packet Decode')}</h4>
          <button className="mcpm-modal-close" onClick={onClose} aria-label={t('common.close', 'Close')}>×</button>
        </div>

        <div className="mcpm-modal-body">
          {/* Reception metadata (from the capture, not the wire). */}
          <section className="mcpm-dl-section">
            <h5>{t('meshcore.packets.reception', 'Reception')}</h5>
            <Row label={t('meshcore.packets.time', 'Time')} mono>{time.toLocaleString()}.{String(time.getMilliseconds()).padStart(3, '0')}</Row>
            <Row label={t('meshcore.packets.snr', 'SNR')} mono>{typeof packet.snr === 'number' ? `${packet.snr.toFixed(2)} dB` : '—'}</Row>
            <Row label={t('meshcore.packets.rssi', 'RSSI')} mono>{typeof packet.rssi === 'number' ? `${packet.rssi} dBm` : '—'}</Row>
            <Row label={t('meshcore.packets.size', 'Size')} mono>{typeof packet.payloadSize === 'number' ? `${packet.payloadSize} B` : '—'}</Row>
          </section>

          {!decoded ? (
            <div className="mcpm-error">{t('meshcore.packets.noRaw', 'No raw packet bytes available to decode.')}</div>
          ) : (
            <>
              {/* Header */}
              <section className="mcpm-dl-section">
                <h5>{t('meshcore.packets.header', 'Header')}</h5>
                <Row label={t('meshcore.packets.payloadType', 'Payload')} mono>
                  {decoded.header.payloadTypeName} ({fmtHex(decoded.header.payloadType)})
                </Row>
                <Row label={t('meshcore.packets.routeType', 'Route')} mono>
                  {decoded.header.routeTypeName} ({fmtHex(decoded.header.routeType)})
                </Row>
                <Row label={t('meshcore.packets.version', 'Version')} mono>{decoded.header.payloadVersion}</Row>
                {decoded.transportCodes && (
                  <Row label={t('meshcore.packets.transportCodes', 'Transport codes')} mono>
                    {fmtHex(decoded.transportCodes.code1)}, {fmtHex(decoded.transportCodes.code2)}
                  </Row>
                )}
              </section>

              {/* Path / routing */}
              <section className="mcpm-dl-section">
                <h5>{t('meshcore.packets.path', 'Path')}</h5>
                <Row label="path_len" mono>{decoded.path.rawLen !== null ? fmtHex(decoded.path.rawLen) : '—'}</Row>
                {decoded.path.direct ? (
                  <Row label={t('meshcore.packets.routing', 'Routing')}>{t('meshcore.packets.directNoRelay', 'Direct (no relays)')}</Row>
                ) : (
                  <>
                    <Row label={t('meshcore.packets.hops', 'Hops')} mono>{decoded.path.hopCount}</Row>
                    <Row label={t('meshcore.packets.hashWidth', 'Hash width')} mono>{decoded.path.hashSize} B</Row>
                    <Row label={t('meshcore.packets.relayChain', 'Relay chain')} mono wrap>
                      {decoded.path.hops.length ? decoded.path.hops.join(' to ') : '—'}
                    </Row>
                  </>
                )}
              </section>

              {/* Payload — best-effort decode */}
              <section className="mcpm-dl-section">
                <h5>{t('meshcore.packets.payload', 'Payload')} ({decoded.payload.sizeBytes} B)</h5>

                {decoded.payload.advert && (
                  <>
                    <Row label={t('meshcore.packets.advType', 'Advert type')} mono>
                      {decoded.payload.advert.advTypeName} ({decoded.payload.advert.advType})
                    </Row>
                    {decoded.payload.advert.name !== undefined && (
                      <Row label={t('meshcore.packets.nodeName', 'Node name')}>{decoded.payload.advert.name || '(empty)'}</Row>
                    )}
                    <Row label={t('meshcore.packets.publicKey', 'Public key')} mono wrap>{decoded.payload.advert.publicKey}</Row>
                    <Row label={t('meshcore.packets.advTimestamp', 'Advert time')} mono>
                      {decoded.payload.advert.timestampIso ?? decoded.payload.advert.timestamp}
                    </Row>
                    {decoded.payload.advert.latitude !== undefined && (
                      <Row label={t('meshcore.packets.location', 'Location')} mono>
                        {decoded.payload.advert.latitude.toFixed(5)}, {decoded.payload.advert.longitude?.toFixed(5)}
                      </Row>
                    )}
                    {decoded.payload.advert.feat1 !== undefined && (
                      <Row label="feat1" mono>{fmtHex(decoded.payload.advert.feat1)}</Row>
                    )}
                    {decoded.payload.advert.feat2 !== undefined && (
                      <Row label="feat2" mono>{fmtHex(decoded.payload.advert.feat2)}</Row>
                    )}
                    <Row label={t('meshcore.packets.signature', 'Signature')} mono wrap>{decoded.payload.advert.signature}</Row>
                  </>
                )}

                {decoded.payload.message && (
                  <>
                    <Row label={t('meshcore.packets.destHash', 'Dest hash')} mono>{decoded.payload.message.destHash}</Row>
                    <Row label={t('meshcore.packets.srcHash', 'Src hash')} mono>{decoded.payload.message.srcHash}</Row>
                    <Row label={t('meshcore.packets.encrypted', 'Encrypted body')} mono wrap>
                      <UiIcon name="encrypted" size={14} /> {decoded.payload.message.encryptedHex || '(none)'}
                    </Row>
                  </>
                )}

                {decoded.payload.ack && (
                  <Row label={t('meshcore.packets.ackCode', 'ACK code')} mono>{decoded.payload.ack.ackCodeHex}</Row>
                )}

                <Row label={t('meshcore.packets.payloadHex', 'Payload (hex)')} mono wrap>{decoded.payload.hex || '—'}</Row>
              </section>

              {/* Raw bytes */}
              <section className="mcpm-dl-section">
                <h5>{t('meshcore.packets.raw', 'Raw')} ({decoded.totalBytes} B)</h5>
                <pre className="mcpm-raw-hex">{packet.rawHex}</pre>
              </section>

              {decoded.errors.length > 0 && (
                <div className="mcpm-decode-note">
                  {t('meshcore.packets.decodeNote', 'Partial decode')}: {decoded.errors.join('; ')}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default MeshCorePacketDetailModal;
