import { describe, it, expect } from 'vitest';
import {
  PacketSignaturePolicy,
  PACKET_SIGNATURE_POLICIES,
  getPacketSignaturePolicyName,
  isPacketSignaturePolicy,
  policyChangeConfirmKind,
  policyToSend,
  supportsPacketSignaturePolicy,
  toKnownPolicy,
} from './packetSignaturePolicy';

const { COMPATIBLE, BALANCED, STRICT } = PacketSignaturePolicy;

describe('PacketSignaturePolicy', () => {
  it('matches config.proto: COMPATIBLE 0, BALANCED 1, STRICT 2', () => {
    expect([COMPATIBLE, BALANCED, STRICT]).toEqual([0, 1, 2]);
    expect(PACKET_SIGNATURE_POLICIES).toEqual([0, 1, 2]);
  });

  it.each([[0, true], [1, true], [2, true], [3, false], [-1, false], [1.5, false], ['1', false], [null, false], [undefined, false], [true, false]])(
    'isPacketSignaturePolicy(%j) is %s',
    (value, expected) => {
      expect(isPacketSignaturePolicy(value)).toBe(expected);
    },
  );

  it('names a value, and does not invent a name for one it does not know', () => {
    expect(getPacketSignaturePolicyName(2)).toBe('STRICT');
    expect(getPacketSignaturePolicyName(0)).toBe('COMPATIBLE');
    expect(getPacketSignaturePolicyName(9)).toBe('UNKNOWN(9)');
  });
});

describe('supportsPacketSignaturePolicy', () => {
  it.each([
    ['2.8.0.abcdef0', true],
    ['2.8.0', true],
    ['2.8.1-rc1', true],
    ['2.9.0', true],
    ['3.0.0', true],
    ['2.7.99.abcdef0', false],
    ['2.7.15', false],
    ['Unknown', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('%j -> %s', (version, expected) => {
    expect(supportsPacketSignaturePolicy(version)).toBe(expected);
  });
});

describe('policyChangeConfirmKind', () => {
  it.each([
    [COMPATIBLE, BALANCED, 'plain'],
    [STRICT, BALANCED, 'plain'],
    [COMPATIBLE, STRICT, 'typed'],
    [BALANCED, STRICT, 'typed'],
    [BALANCED, COMPATIBLE, 'none'],
    [STRICT, COMPATIBLE, 'none'],
    [STRICT, STRICT, 'none'],
    [BALANCED, BALANCED, 'none'],
    [COMPATIBLE, null, 'none'],
  ])('%s -> %s needs "%s"', (from, to, kind) => {
    expect(policyChangeConfirmKind(from, to)).toBe(kind);
  });
});

describe('policyToSend', () => {
  it('sends nothing when the policy is unchanged', () => {
    expect(policyToSend(COMPATIBLE, COMPATIBLE)).toBeUndefined();
    expect(policyToSend(STRICT, STRICT)).toBeUndefined();
  });

  it('sends the new value when it changed, an explicit COMPATIBLE included', () => {
    expect(policyToSend(COMPATIBLE, STRICT)).toBe(STRICT);
    expect(policyToSend(STRICT, COMPATIBLE)).toBe(COMPATIBLE);
  });

  it('never overwrites a policy that was not read from the node', () => {
    expect(policyToSend(null, STRICT)).toBeUndefined();
    expect(policyToSend(null, COMPATIBLE)).toBeUndefined();
    expect(policyToSend(STRICT, null)).toBeUndefined();
  });

  it('sends nothing for a value it does not know', () => {
    expect(policyToSend(COMPATIBLE, 7)).toBeUndefined();
  });
});

describe('toKnownPolicy', () => {
  it('keeps 0 as a known policy, and reads anything else as unknown', () => {
    expect(toKnownPolicy(0)).toBe(0);
    expect(toKnownPolicy(2)).toBe(2);
    expect(toKnownPolicy(undefined)).toBeNull();
    expect(toKnownPolicy(5)).toBeNull();
    expect(toKnownPolicy('STRICT')).toBeNull();
  });
});
