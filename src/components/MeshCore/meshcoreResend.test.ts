import { describe, it, expect } from 'vitest';
import { resendAvailability } from './meshcoreResend';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const SELF = 'a'.repeat(64);
const NOW = 10_000_000;
const own = (extra: Partial<MeshCoreMessage> = {}): MeshCoreMessage => ({
  id: 'm1', fromPublicKey: SELF, toPublicKey: 'channel-1', text: 'hi',
  timestamp: NOW - 120_000, senderTimestamp: 1, ...extra,
});

describe('resendAvailability', () => {
  it('offers resend on our own channel send', () => {
    expect(resendAvailability(own(), SELF, NOW).kind).toBe('ready');
  });
  it('never offers resend on a reaction row', () => {
    expect(resendAvailability(own({ reactionEmoji: '👍' }), SELF, NOW).kind).toBe('never');
  });

  it('default (no required repeater): hidden once any repeater is heard', () => {
    const m = own({ heardBy: [{ hash: 'aa' }] });
    expect(resendAvailability(m, SELF, NOW).kind).toBe('never');
    // Passing an empty opts bag must not change the default behavior.
    expect(resendAvailability(m, SELF, NOW, {}).kind).toBe('never');
  });

  describe('#6178 → #6193 Required Repeaters gate', () => {
    const REQ = 'bb'.repeat(16); // 32-char full pubkey
    const OTHER = 'cc'.repeat(16);
    const repeaters = [
      { publicKey: REQ, advType: 2 },
      { publicKey: OTHER, advType: 2 },
    ];

    it('hides resend only once the required repeater is uniquely heard', () => {
      const m = own({ heardBy: [{ hash: 'bb' }] });
      expect(resendAvailability(m, SELF, NOW, { requiredRepeaterKeys: [REQ], repeaters }).kind).toBe('never');
    });

    it('keeps resend when a DIFFERENT repeater relayed it', () => {
      const m = own({ heardBy: [{ hash: 'cc' }] });
      expect(resendAvailability(m, SELF, NOW, { requiredRepeaterKeys: [REQ], repeaters }).kind).toBe('ready');
    });

    it('keeps resend on an ambiguous prefix collision', () => {
      // Both REQ and a decoy share the 'bb' prefix → ambiguous → keep button.
      const decoy = 'bb00000000000000000000000000ffff';
      const m = own({ heardBy: [{ hash: 'bb' }] });
      expect(
        resendAvailability(m, SELF, NOW, {
          requiredRepeaterKeys: [REQ],
          repeaters: [{ publicKey: REQ, advType: 2 }, { publicKey: decoy, advType: 2 }],
        }).kind,
      ).toBe('ready');
    });

    it('keeps resend when no repeater has been heard yet', () => {
      const m = own();
      expect(resendAvailability(m, SELF, NOW, { requiredRepeaterKeys: [REQ], repeaters }).kind).toBe('ready');
    });

    it('ANY mode: one of the listed repeaters heard hides resend', () => {
      const m = own({ heardBy: [{ hash: 'cc' }] });
      expect(resendAvailability(m, SELF, NOW, { requiredRepeaterKeys: [REQ, OTHER], requiredRepeaterMode: 'any', repeaters }).kind).toBe('never');
    });

    it('ALL mode: keeps resend until every listed repeater is heard', () => {
      const partial = own({ heardBy: [{ hash: 'bb' }] });
      expect(resendAvailability(partial, SELF, NOW, { requiredRepeaterKeys: [REQ, OTHER], requiredRepeaterMode: 'all', repeaters }).kind).toBe('ready');
      const full = own({ heardBy: [{ hash: 'bb' }, { hash: 'cc' }] });
      expect(resendAvailability(full, SELF, NOW, { requiredRepeaterKeys: [REQ, OTHER], requiredRepeaterMode: 'all', repeaters }).kind).toBe('never');
    });
  });
});
