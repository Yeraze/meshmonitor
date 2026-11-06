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

  describe('#6194 direct messages (parity with channel)', () => {
    const PEER = 'b'.repeat(64);
    const dm = (extra: Partial<MeshCoreMessage> = {}): MeshCoreMessage => ({
      id: 'dm1', fromPublicKey: SELF, toPublicKey: PEER, text: 'hi',
      timestamp: NOW - 120_000, senderTimestamp: 1, ...extra,
    });

    it('offers resend on our own DM that no repeater relayed and no ACK came', () => {
      expect(resendAvailability(dm(), SELF, NOW).kind).toBe('ready');
    });

    it('offers resend on a DM whose ACK timed out (not_confirmed)', () => {
      expect(resendAvailability(dm({ deliveryStatus: 'failed' }), SELF, NOW).kind).toBe('ready');
    });

    it('NEVER offers resend on a DM the recipient acknowledged (delivered)', () => {
      expect(resendAvailability(dm({ deliveryStatus: 'delivered' }), SELF, NOW).kind).toBe('never');
    });

    it('hides resend once any repeater relayed the DM (default, no required list)', () => {
      expect(resendAvailability(dm({ heardBy: [{ hash: 'aa' }] }), SELF, NOW).kind).toBe('never');
    });

    it('never offers resend on a room post', () => {
      expect(resendAvailability(dm({ messageType: 'room_post' }), SELF, NOW).kind).toBe('never');
    });

    it('never offers resend on a received DM', () => {
      expect(resendAvailability(dm({ fromPublicKey: PEER }), SELF, NOW).kind).toBe('never');
    });

    it('applies the Required Repeaters gate to DMs too', () => {
      const REQ = 'bb'.repeat(16);
      const repeaters = [{ publicKey: REQ, advType: 2 }];
      // Heard by a non-required repeater → keep the button.
      expect(
        resendAvailability(dm({ heardBy: [{ hash: 'cc' }] }), SELF, NOW, { requiredRepeaterKeys: [REQ], repeaters }).kind,
      ).toBe('ready');
      // The required repeater uniquely heard → hide it.
      expect(
        resendAvailability(dm({ heardBy: [{ hash: 'bb' }] }), SELF, NOW, { requiredRepeaterKeys: [REQ], repeaters }).kind,
      ).toBe('never');
    });
  });
});
