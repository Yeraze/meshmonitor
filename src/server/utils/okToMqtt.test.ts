import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServiceEnvelopeShape } from '../mqttPacketFilter.js';

// channelDecryptionService is mocked at the module level so
// resolveOkToMqttForEnvelope's decrypt branch can be driven deterministically
// without touching the real channel-database cache refresh path (#4114).
const tryDecrypt = vi.fn();
vi.mock('../services/channelDecryptionService.js', () => ({
  channelDecryptionService: {
    tryDecrypt: (...args: unknown[]) => tryDecrypt(...args),
  },
}));

import {
  readBitfieldOkToMqtt,
  resolveOkToMqttForEnvelope,
  allowsUplink,
  parseGatewayNodeNum,
  detectOkToMqttViolation,
} from './okToMqtt.js';

const ORIGINATOR = 0x11111111;
const GATEWAY = 0x22222222;

function gwId(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

function envelope(opts: {
  from?: number;
  to?: number;
  bitfield?: number;
  /** Whether `packet.decoded` is present at all (false ⇒ simulates an
   *  encrypted packet the ingest layer never managed to decrypt/synthesize). */
  hasDecoded?: boolean;
  gatewayId?: string;
  encrypted?: Uint8Array;
  id?: number;
  channel?: number;
} = {}): ServiceEnvelopeShape {
  const { from, to, bitfield, hasDecoded = true, gatewayId, encrypted, id, channel } = opts;
  return {
    gatewayId,
    packet: {
      from,
      to,
      id,
      channel,
      encrypted,
      decoded: hasDecoded ? { bitfield } : undefined,
    },
  };
}

beforeEach(() => {
  tryDecrypt.mockReset();
});

describe('readBitfieldOkToMqtt', () => {
  it('undefined/null/NaN/non-number ⇒ unknown', () => {
    expect(readBitfieldOkToMqtt(undefined)).toBe('unknown');
    expect(readBitfieldOkToMqtt(null)).toBe('unknown');
    expect(readBitfieldOkToMqtt(NaN)).toBe('unknown');
    expect(readBitfieldOkToMqtt('1' as unknown as number)).toBe('unknown');
  });

  it('bit 0 clear ⇒ no (regardless of other bits)', () => {
    expect(readBitfieldOkToMqtt(0)).toBe('no');
    expect(readBitfieldOkToMqtt(2)).toBe('no');
  });

  it('bit 0 set ⇒ yes (regardless of other bits)', () => {
    expect(readBitfieldOkToMqtt(1)).toBe('yes');
    expect(readBitfieldOkToMqtt(3)).toBe('yes');
    expect(readBitfieldOkToMqtt(0xffffffff)).toBe('yes');
  });
});

describe('resolveOkToMqttForEnvelope', () => {
  it('plaintext bit set ⇒ yes, no decrypt attempted', async () => {
    await expect(resolveOkToMqttForEnvelope(envelope({ bitfield: 1 }))).resolves.toBe('yes');
    expect(tryDecrypt).not.toHaveBeenCalled();
  });

  it('plaintext bit clear ⇒ no, no decrypt attempted', async () => {
    await expect(resolveOkToMqttForEnvelope(envelope({ bitfield: 0 }))).resolves.toBe('no');
    expect(tryDecrypt).not.toHaveBeenCalled();
  });

  it('decoded present, bitfield absent, no encrypted ⇒ unknown, no decrypt attempted', async () => {
    await expect(resolveOkToMqttForEnvelope(envelope({ hasDecoded: true }))).resolves.toBe('unknown');
    expect(tryDecrypt).not.toHaveBeenCalled();
  });

  it('decoded present, bitfield absent, encrypted present ⇒ decrypt attempted with (enc, id, from, channelHash)', async () => {
    tryDecrypt.mockResolvedValue({ success: false });
    const enc = new Uint8Array([1, 2, 3]);
    await resolveOkToMqttForEnvelope(
      envelope({ hasDecoded: true, encrypted: enc, id: 42, from: ORIGINATOR, channel: 7 }),
    );
    expect(tryDecrypt).toHaveBeenCalledTimes(1);
    expect(tryDecrypt).toHaveBeenCalledWith(enc, 42, ORIGINATOR, 7);
  });

  it('decrypt success with numeric bitfield ⇒ mapped through readBitfieldOkToMqtt', async () => {
    tryDecrypt.mockResolvedValue({ success: true, bitfield: 1 });
    const enc = new Uint8Array([1]);
    await expect(
      resolveOkToMqttForEnvelope(envelope({ hasDecoded: false, encrypted: enc, id: 1, from: ORIGINATOR })),
    ).resolves.toBe('yes');
  });

  it('decrypt success with non-numeric bitfield ⇒ unknown', async () => {
    tryDecrypt.mockResolvedValue({ success: true, bitfield: undefined });
    const enc = new Uint8Array([1]);
    await expect(
      resolveOkToMqttForEnvelope(envelope({ hasDecoded: false, encrypted: enc, id: 1, from: ORIGINATOR })),
    ).resolves.toBe('unknown');
  });

  it('decrypt failure ⇒ unknown', async () => {
    tryDecrypt.mockResolvedValue({ success: false, error: 'no matching key' });
    const enc = new Uint8Array([1]);
    await expect(
      resolveOkToMqttForEnvelope(envelope({ hasDecoded: false, encrypted: enc, id: 1, from: ORIGINATOR })),
    ).resolves.toBe('unknown');
  });

  it('missing id/from ⇒ unknown, no decrypt attempted', async () => {
    const enc = new Uint8Array([1]);
    await expect(
      resolveOkToMqttForEnvelope(envelope({ hasDecoded: false, encrypted: enc })),
    ).resolves.toBe('unknown');
    expect(tryDecrypt).not.toHaveBeenCalled();
  });
});

describe('allowsUplink', () => {
  it('fail-closed: yes⇒true, no⇒false, unknown⇒false', () => {
    expect(allowsUplink('yes')).toBe(true);
    expect(allowsUplink('no')).toBe(false);
    expect(allowsUplink('unknown')).toBe(false);
  });

  it('the tri-state vs fail-closed split: unknown drops for uplink but is only "suspected" for detection', () => {
    expect(allowsUplink('unknown')).toBe(false);

    const r = detectOkToMqttViolation(envelope({ from: ORIGINATOR, hasDecoded: true, gatewayId: gwId(GATEWAY) }));
    expect(r.state).toBe('unknown');
    expect(r.isSuspected).toBe(true);
    expect(r.isViolation).toBe(false);
  });
});

describe('parseGatewayNodeNum', () => {
  it('parses a well-formed !hex id', () => {
    expect(parseGatewayNodeNum('!aabbccdd')).toBe(0xaabbccdd);
  });

  it('unsigned-normalizes the maximum u32', () => {
    expect(parseGatewayNodeNum('!ffffffff')).toBe(4294967295);
  });

  it('missing/undefined/null/empty ⇒ null', () => {
    expect(parseGatewayNodeNum(undefined)).toBeNull();
    expect(parseGatewayNodeNum(null)).toBeNull();
    expect(parseGatewayNodeNum('')).toBeNull();
  });

  it('missing "!" prefix ⇒ null', () => {
    expect(parseGatewayNodeNum('aabbccdd')).toBeNull();
  });

  it('non-hex payload ⇒ null', () => {
    expect(parseGatewayNodeNum('!zzzz')).toBeNull();
  });
});

describe('detectOkToMqttViolation — §2(f) predicate table', () => {
  it('table row 1: bit=1, gateway ≠ originator ⇒ not a violation', () => {
    const r = detectOkToMqttViolation(envelope({ from: ORIGINATOR, bitfield: 1, gatewayId: gwId(GATEWAY) }));
    expect(r.state).toBe('yes');
    expect(r.relayed).toBe(true);
    expect(r.isViolation).toBe(false);
    expect(r.isSuspected).toBe(false);
  });

  it('table row 2: bit=1, gateway = originator ⇒ not a violation', () => {
    const r = detectOkToMqttViolation(envelope({ from: ORIGINATOR, bitfield: 1, gatewayId: gwId(ORIGINATOR) }));
    expect(r.state).toBe('yes');
    expect(r.relayed).toBe(false);
    expect(r.isViolation).toBe(false);
  });

  it('table row 3: bit=0, gateway ≠ originator ⇒ CONFIRMED VIOLATION', () => {
    const r = detectOkToMqttViolation(envelope({ from: ORIGINATOR, bitfield: 0, gatewayId: gwId(GATEWAY) }));
    expect(r.state).toBe('no');
    expect(r.relayed).toBe(true);
    expect(r.isViolation).toBe(true);
    expect(r.isSuspected).toBe(false);
  });

  it('table row 4 (named): originator publishing its own packet must NOT flag, even with bit 0', () => {
    const r = detectOkToMqttViolation(envelope({ from: ORIGINATOR, bitfield: 0, gatewayId: gwId(ORIGINATOR) }));
    expect(r.relayed).toBe(false);
    expect(r.isViolation).toBe(false);
    expect(r.isSuspected).toBe(false);
  });

  it('table row 5: plaintext with bitfield field simply unset ⇒ suspected iff relayed, never confirmed', () => {
    const r = detectOkToMqttViolation(envelope({ from: ORIGINATOR, hasDecoded: true, gatewayId: gwId(GATEWAY) }));
    expect(r.state).toBe('unknown');
    expect(r.relayed).toBe(true);
    expect(r.isSuspected).toBe(true);
    expect(r.isViolation).toBe(false);
  });

  it('table row 6: encrypted with no decoded synthesized (unmatched PSK) ⇒ suspected iff relayed, never confirmed', () => {
    const r = detectOkToMqttViolation(envelope({ from: ORIGINATOR, hasDecoded: false, gatewayId: gwId(GATEWAY) }));
    expect(r.state).toBe('unknown');
    expect(r.bitfield).toBeNull();
    expect(r.relayed).toBe(true);
    expect(r.isSuspected).toBe(true);
    expect(r.isViolation).toBe(false);
  });

  it('table row 7: encrypted with PSK matched (bitfield synthesized into decoded) ⇒ rows 1-4 apply', () => {
    // By the time detectOkToMqttViolation is called, ingestServiceEnvelopeInner
    // has already synthesized packet.decoded.bitfield from the decrypt result
    // (§2(b)) — so a server-decrypted reception is indistinguishable here from
    // a plaintext one, and reproduces row 3's confirmed-violation outcome.
    const r = detectOkToMqttViolation(envelope({ from: ORIGINATOR, bitfield: 0, gatewayId: gwId(GATEWAY) }));
    expect(r.isViolation).toBe(true);
  });

  it('table row 8: gatewayId null/absent ⇒ nothing recorded (relaying cannot be proven)', () => {
    const r = detectOkToMqttViolation(envelope({ from: ORIGINATOR, bitfield: 0 }));
    expect(r.gatewayNodeNum).toBeNull();
    expect(r.relayed).toBe(false);
    expect(r.isViolation).toBe(false);
    expect(r.isSuspected).toBe(false);
  });

  it('table row 9: malformed gatewayId ⇒ nothing recorded', () => {
    const r = detectOkToMqttViolation(envelope({ from: ORIGINATOR, bitfield: 0, gatewayId: 'not-a-gateway-id' }));
    expect(r.gatewayNodeNum).toBeNull();
    expect(r.relayed).toBe(false);
    expect(r.isViolation).toBe(false);
  });

  it('table row 10: packet.from not numeric ⇒ nothing recorded', () => {
    const r = detectOkToMqttViolation(envelope({ bitfield: 0, gatewayId: gwId(GATEWAY) }));
    expect(r.fromNode).toBeNull();
    expect(r.relayed).toBe(false);
    expect(r.isViolation).toBe(false);
  });

  it('table row 11: fromNode=0 is compared like any other numeric value', () => {
    const relayed = detectOkToMqttViolation(envelope({ from: 0, bitfield: 0, gatewayId: gwId(GATEWAY) }));
    expect(relayed.fromNode).toBe(0);
    expect(relayed.relayed).toBe(true);
    expect(relayed.isViolation).toBe(true);

    const selfPublish = detectOkToMqttViolation(envelope({ from: 0, bitfield: 0, gatewayId: gwId(0) }));
    expect(selfPublish.relayed).toBe(false);
    expect(selfPublish.isViolation).toBe(false);
  });

  it('table row 12: predicate is to-agnostic (broadcast vs DM produce the same outcome)', () => {
    const broadcast = detectOkToMqttViolation(
      envelope({ from: ORIGINATOR, to: 0xffffffff, bitfield: 0, gatewayId: gwId(GATEWAY) }),
    );
    const dm = detectOkToMqttViolation(
      envelope({ from: ORIGINATOR, to: 0x99999999, bitfield: 0, gatewayId: gwId(GATEWAY) }),
    );
    expect(broadcast.isViolation).toBe(true);
    expect(dm.isViolation).toBe(true);
  });

  it('table rows 13-14: bridge downlink and local-broker publish are evaluated identically (no direction concept in the predicate)', () => {
    // Both mqttBridgeManager.handleDownlink and mqttBrokerManager.handlePublish
    // pass the same ServiceEnvelopeShape into this pure function; there is no
    // direction-specific branch here to diverge, so an identical envelope
    // always yields an identical result regardless of which call site built it.
    const a = envelope({ from: ORIGINATOR, bitfield: 0, gatewayId: gwId(GATEWAY) });
    const b = envelope({ from: ORIGINATOR, bitfield: 0, gatewayId: gwId(GATEWAY) });
    expect(detectOkToMqttViolation(a)).toEqual(detectOkToMqttViolation(b));
  });

  it('table row 15 / §2(f.1) (named): a gateway equal to our own localGatewayNodeNum must NOT flag, even with bit 0', () => {
    const e = envelope({ from: ORIGINATOR, bitfield: 0, gatewayId: gwId(GATEWAY) });
    const r = detectOkToMqttViolation(e, GATEWAY);
    expect(r.selfGateway).toBe(true);
    expect(r.relayed).toBe(false);
    expect(r.isViolation).toBe(false);
    expect(r.isSuspected).toBe(false);
  });

  it('§2(f.1) complement: localGatewayNodeNum = null ⇒ guard inert, falls back to the plain gateway≠originator test', () => {
    const e = envelope({ from: ORIGINATOR, bitfield: 0, gatewayId: gwId(GATEWAY) });
    const r = detectOkToMqttViolation(e, null);
    expect(r.selfGateway).toBe(false);
    expect(r.relayed).toBe(true);
    expect(r.isViolation).toBe(true);
  });

  it('§2(f.1) complement: localGatewayNodeNum set but not matching ⇒ guard does not over-suppress, violation still flags', () => {
    const e = envelope({ from: ORIGINATOR, bitfield: 0, gatewayId: gwId(GATEWAY) });
    const OTHER_LOCAL_NODE = 0x33333333;
    const r = detectOkToMqttViolation(e, OTHER_LOCAL_NODE);
    expect(r.selfGateway).toBe(false);
    expect(r.relayed).toBe(true);
    expect(r.isViolation).toBe(true);
  });

  // Row 16 (pre-ingest-filter drops: topic/node/portnum pre-filtering) is out
  // of scope for this pure function — those drops happen upstream, before an
  // envelope ever reaches ingestServiceEnvelope, so detectOkToMqttViolation is
  // never invoked for them. Nothing to unit test here; noted for table
  // completeness (epic decision 3, #4114).
});
