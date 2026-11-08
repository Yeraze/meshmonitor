/**
 * Sender fields derived from a raw MeshCore OTA packet (#6262 P4).
 *
 * ONE derivation, shared by the server insert path
 * (`meshcorePacketLogService.logPacket`) and the client (live-row matching and
 * row rendering). Built on `decodeMeshCorePacket`; never throws.
 *
 *   ADVERT                    srcHash = first byte of the advert key; senderPubKey = key; advertName
 *   REQ/RESPONSE/TXT_MSG      srcHash = plaintext src byte
 *   ANON_REQ                  layout dest(1) | sender pubkey(32) | ...; senderPubKey = key, srcHash = its first byte
 *   GRP_TXT/GRP_DATA/ACK/etc  all null (no plaintext sender)
 */
import { decodeMeshCorePacket } from './meshcorePacketDecode.js';

export interface MeshCorePacketDerivedFields {
  srcHash: string | null;
  senderPubKey: string | null;
  advertName: string | null;
}

const EMPTY: MeshCorePacketDerivedFields = { srcHash: null, senderPubKey: null, advertName: null };

export function deriveMeshCorePacketFields(rawHex: string | null | undefined): MeshCorePacketDerivedFields {
  try {
    const d = decodeMeshCorePacket(rawHex);
    if (!d) return { ...EMPTY };
    const type = d.header.payloadType;
    if (type === 0x04) {
      const a = d.payload.advert;
      if (!a) return { ...EMPTY };
      const key = a.publicKey.toLowerCase();
      return {
        srcHash: key.slice(0, 2),
        senderPubKey: key,
        advertName: a.name ? a.name : null,
      };
    }
    if (type === 0x07) {
      // dest hash (1 byte) then the 32-byte sender key.
      const hex = d.payload.hex.toLowerCase();
      if (hex.length >= 66) {
        const key = hex.slice(2, 66);
        return { srcHash: key.slice(0, 2), senderPubKey: key, advertName: null };
      }
      return { ...EMPTY };
    }
    if (type === 0x00 || type === 0x01 || type === 0x02) {
      const m = d.payload.message;
      return { srcHash: m ? m.srcHash.toLowerCase() : null, senderPubKey: null, advertName: null };
    }
    return { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}
