/**
 * MeshCorePacketDetailModal — best-effort decode of a captured MeshCore OTA
 * packet, shown when a row in the MeshCore Packet Monitor is clicked. The
 * MeshCore analogue of the Meshtastic packet-detail modal: it parses the raw
 * hex with `decodeMeshCorePacket` and lays out the header, path, and (where
 * unencrypted) the payload contents.
 *
 * GRP_TXT / GRP_DATA (#5567, #5568): the browser holds no channel key, so the
 * modal asks the server to open the frame. The server answers with plaintext
 * only when this viewer may read a channel holding the key; otherwise the
 * frame stays ciphertext under an "Unknown channel" note.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshCoreOtaPacketEvent } from '../../hooks/useWebSocket';
import { decodeMeshCorePacket } from '../../utils/meshcorePacketDecode';
import { useDialogA11y } from '../../hooks/useDialogA11y';
import { UiIcon } from '../icons';
import apiService, { type MeshCoreGroupPacketPlaintext } from '../../services/api';
import styles from './MeshCorePacketDetailModal.module.css';

interface Props {
  packet: MeshCoreOtaPacketEvent;
  /** The source being viewed. Without it a group packet stays ciphertext. */
  sourceId?: string;
  onClose: () => void;
}

type GroupDecodeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'done'; result: MeshCoreGroupPacketPlaintext };

/** Classic 16-bytes-per-line dump: offset, hex, printable ASCII. */
function hexAsciiDump(hex: string): string {
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += 32) {
    const chunk = hex.slice(i, i + 32);
    const bytes = chunk.match(/../g) ?? [];
    const ascii = bytes
      .map((b) => {
        const n = parseInt(b, 16);
        return n >= 0x20 && n < 0x7f ? String.fromCharCode(n) : '.';
      })
      .join('');
    lines.push(`${(i / 2).toString(16).padStart(4, '0')}  ${bytes.join(' ').padEnd(47, ' ')}  ${ascii}`);
  }
  return lines.join('\n');
}

const Row: React.FC<{ label: string; children: React.ReactNode; mono?: boolean; wrap?: boolean }> = ({ label, children, mono, wrap }) => (
  <div className="mcpm-dl-row">
    <span className="mcpm-dl-label">{label}</span>
    <span className={`mcpm-dl-value${mono ? ' mcpm-mono' : ''}${wrap ? ' mcpm-dl-wrap' : ''}`}>{children}</span>
  </div>
);

const fmtHex = (n: number) => `0x${n.toString(16).padStart(2, '0')}`;

const MeshCorePacketDetailModal: React.FC<Props> = ({ packet, sourceId, onClose }) => {
  const { t } = useTranslation();
  const { contentRef, onKeyDown } = useDialogA11y(onClose);
  const rawHex = packet.rawHex ?? '';
  const decoded = decodeMeshCorePacket(rawHex);
  // GRP_TXT and GRP_DATA share one outer frame; see meshcorePacketDecode.
  const group = decoded?.payload.groupText ?? decoded?.payload.groupData;
  const hasGroup = !!group;

  const [groupDecode, setGroupDecode] = useState<GroupDecodeState>({ status: 'idle' });
  useEffect(() => {
    if (!hasGroup || !sourceId) {
      setGroupDecode({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setGroupDecode({ status: 'loading' });
    apiService
      .decodeMeshCoreGroupPacket(sourceId, rawHex)
      .then((result) => {
        if (!cancelled) setGroupDecode({ status: 'done', result });
      })
      .catch(() => {
        if (!cancelled) setGroupDecode({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [hasGroup, sourceId, rawHex]);

  const plain = groupDecode.status === 'done' && groupDecode.result.decrypted ? groupDecode.result : null;

  const time = new Date(packet.timestamp);

  return (
    <div className="mcpm-modal" onClick={onClose} role="presentation">
      <div
        className="mcpm-modal-content"
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcpm-detail-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mcpm-modal-header">
          <h4 id="mcpm-detail-title">{t('meshcore.packets.detailTitle', 'Packet Decode')}</h4>
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

                {group && (
                  <>
                    <Row label={t('meshcore.packets.channelHash', 'Channel hash')} mono>0x{group.channelHash}</Row>
                    <Row label={t('meshcore.packets.cipherMac', 'Cipher MAC')} mono>{group.cipherMacHex}</Row>

                    {groupDecode.status === 'loading' && (
                      <div className={styles.status} role="status">
                        {t('meshcore.packets.decrypting', 'Decrypting…')}
                      </div>
                    )}
                    {groupDecode.status === 'error' && (
                      <div className={`${styles.status} ${styles.statusError}`} role="alert">
                        {t('meshcore.packets.decryptError', 'Could not ask the server to decrypt this packet.')}
                      </div>
                    )}
                    {(groupDecode.status === 'idle' || (groupDecode.status === 'done' && !plain)) && (
                      <div className={styles.status} data-testid="mcpm-unknown-channel">
                        {t('meshcore.packets.unknownChannel', 'Unknown channel (hash 0x{{hash}})', {
                          hash: group.channelHash,
                        })}
                      </div>
                    )}

                    {plain && (
                      <div className={styles.plaintext} data-testid="mcpm-plaintext">
                        <Row label={t('meshcore.packets.channel', 'Channel')}>
                          {plain.channelName || t('meshcore.packets.channelUnnamed', '(unnamed)')}
                          <span className={styles.origin}>
                            {plain.keyOrigin.kind === 'virtual'
                              ? t('meshcore.packets.keyOriginVirtual', 'virtual channel')
                              : plain.keyOrigin.currentSource
                                ? t('meshcore.packets.keyOriginThisSource', 'this source')
                                : t('meshcore.packets.keyOriginSource', 'key from source {{name}}', {
                                    name: plain.keyOrigin.sourceName,
                                  })}
                          </span>
                        </Row>
                        {plain.text && (
                          <>
                            <Row label={t('meshcore.packets.sender', 'Sender')}>
                              {plain.text.sender ?? t('meshcore.packets.senderUnknown', '(not given)')}
                            </Row>
                            <Row label={t('meshcore.packets.senderTime', 'Sender time')} mono>
                              {plain.text.timestampSec > 0
                                ? new Date(plain.text.timestampSec * 1000).toLocaleString()
                                : '—'}
                            </Row>
                            <Row label={t('meshcore.packets.messageText', 'Text')}>
                              <span className={styles.messageText}>{plain.text.text}</span>
                            </Row>
                          </>
                        )}
                        {plain.data && (
                          <>
                            <Row label={t('meshcore.packets.dataType', 'Data type')} mono>
                              0x{plain.data.dataType.toString(16).padStart(4, '0')}
                            </Row>
                            <Row label={t('meshcore.packets.dataLength', 'Data length')} mono>
                              {plain.data.dataHex.length / 2} B
                            </Row>
                            <Row label={t('meshcore.packets.dataBody', 'Data')}>
                              {plain.data.dataHex ? (
                                <pre className={styles.hexDump}>{hexAsciiDump(plain.data.dataHex)}</pre>
                              ) : (
                                '—'
                              )}
                            </Row>
                          </>
                        )}
                      </div>
                    )}

                    <Row label={t('meshcore.packets.ciphertext', 'Ciphertext')} mono wrap>
                      <UiIcon name="encrypted" size={14} /> {group.ciphertextHex || '(none)'}
                    </Row>
                  </>
                )}

                {!group && decoded.payload.message && (
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

                {decoded.payload.multipart && (
                  <>
                    <Row label={t('meshcore.packets.multipartRemaining', 'Parts remaining')} mono>
                      {decoded.payload.multipart.remaining}
                    </Row>
                    <Row label={t('meshcore.packets.multipartInner', 'Wrapped payload')} mono>
                      {decoded.payload.multipart.innerTypeName} ({fmtHex(decoded.payload.multipart.innerType)})
                    </Row>
                    {decoded.payload.multipart.ack ? (
                      <Row label={t('meshcore.packets.ackCode', 'ACK code')} mono>
                        {decoded.payload.multipart.ack.ackCodeHex}
                      </Row>
                    ) : (
                      // Nothing decodes a wrapped type we don't handle yet, so
                      // show its bytes here rather than making the reader find
                      // them inside the whole-payload hex below.
                      <Row label={t('meshcore.packets.multipartInnerHex', 'Wrapped payload (hex)')} mono wrap>
                        {decoded.payload.multipart.innerHex || '—'}
                      </Row>
                    )}
                  </>
                )}

                {decoded.payload.control && (
                  <>
                    <Row label={t('meshcore.packets.controlSubType', 'Control type')} mono>
                      {decoded.payload.control.subTypeName} ({fmtHex(decoded.payload.control.subType)})
                    </Row>
                    {decoded.payload.control.discoverRequest && (
                      <>
                        <Row label={t('meshcore.packets.discoverFilter', 'Type filter')} mono>
                          {fmtHex(decoded.payload.control.discoverRequest.filter)}
                        </Row>
                        <Row label={t('meshcore.packets.discoverKeyLength', 'Key requested')} mono>
                          {decoded.payload.control.discoverRequest.prefixOnly
                            ? t('meshcore.packets.discoverKeyPrefix', 'Prefix (8 B)')
                            : t('meshcore.packets.discoverKeyFull', 'Full (32 B)')}
                        </Row>
                        <Row label={t('meshcore.packets.discoverTag', 'Tag')} mono>
                          {decoded.payload.control.discoverRequest.tag}
                        </Row>
                      </>
                    )}
                    {decoded.payload.control.discoverResponse && (
                      <>
                        <Row label={t('meshcore.packets.advType', 'Advert type')} mono>
                          {decoded.payload.control.discoverResponse.advTypeName} ({decoded.payload.control.discoverResponse.advType})
                        </Row>
                        <Row label={t('meshcore.packets.discoverSnrToNode', 'SNR at responder')} mono>
                          {decoded.payload.control.discoverResponse.snr.toFixed(2)} dB
                        </Row>
                        <Row label={t('meshcore.packets.discoverTag', 'Tag')} mono>
                          {decoded.payload.control.discoverResponse.tag}
                        </Row>
                        <Row label={t('meshcore.packets.publicKey', 'Public key')} mono wrap>
                          {decoded.payload.control.discoverResponse.publicKey || '—'}
                        </Row>
                      </>
                    )}
                  </>
                )}

                <Row label={t('meshcore.packets.payloadHex', 'Payload (hex)')} mono wrap>{decoded.payload.hex || '—'}</Row>
              </section>

              {/* Raw bytes */}
              <section className="mcpm-dl-section">
                <h5>{t('meshcore.packets.raw', 'Raw')} ({decoded.totalBytes} B)</h5>
                <pre className="mcpm-raw-hex">{rawHex}</pre>
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
