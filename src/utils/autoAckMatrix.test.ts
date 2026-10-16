import { describe, it, expect } from 'vitest';
import {
  AUTOACK_CELLS,
  DEFAULT_AUTOACK_MATRIX,
  cellServerKeyPrefix,
  matrixToSettings,
  settingsToMatrix,
  type AutoAckMatrix,
} from './autoAckMatrix';

const ALL_KEYS = [
  'autoAckChannelZeroHopReplyEnabled',
  'autoAckChannelZeroHopTapbackEnabled',
  'autoAckChannelZeroHopReplyDmEnabled',
  'autoAckChannelMultiHopReplyEnabled',
  'autoAckChannelMultiHopTapbackEnabled',
  'autoAckChannelMultiHopReplyDmEnabled',
  'autoAckDirectZeroHopReplyEnabled',
  'autoAckDirectZeroHopTapbackEnabled',
  'autoAckDirectZeroHopReplyDmEnabled',
  'autoAckDirectMultiHopReplyEnabled',
  'autoAckDirectMultiHopTapbackEnabled',
  'autoAckDirectMultiHopReplyDmEnabled',
  'autoAckChannelIpReplyEnabled',
  'autoAckChannelIpTapbackEnabled',
  'autoAckChannelIpReplyDmEnabled',
  'autoAckDirectIpReplyEnabled',
  'autoAckDirectIpTapbackEnabled',
  'autoAckDirectIpReplyDmEnabled',
];

describe('autoAckMatrix', () => {
  describe('AUTOACK_CELLS', () => {
    it('has exactly six cells in the expected order', () => {
      expect(AUTOACK_CELLS.map(c => c.id)).toEqual([
        'channelZeroHop',
        'channelMultiHop',
        'channelIp',
        'directZeroHop',
        'directMultiHop',
        'directIp',
      ]);
    });

    it('maps each cell to correct type/hop', () => {
      const byId = Object.fromEntries(AUTOACK_CELLS.map(c => [c.id, c]));
      expect(byId.channelZeroHop).toMatchObject({ type: 'channel', hop: 'zeroHop' });
      expect(byId.channelMultiHop).toMatchObject({ type: 'channel', hop: 'multiHop' });
      expect(byId.directZeroHop).toMatchObject({ type: 'direct', hop: 'zeroHop' });
      expect(byId.directMultiHop).toMatchObject({ type: 'direct', hop: 'multiHop' });
      expect(byId.channelIp).toMatchObject({ type: 'channel', hop: 'ip' });
      expect(byId.directIp).toMatchObject({ type: 'direct', hop: 'ip' });
    });

    it('gives every cell a non-empty human label', () => {
      for (const cell of AUTOACK_CELLS) {
        expect(typeof cell.label).toBe('string');
        expect(cell.label.length).toBeGreaterThan(0);
      }
    });
  });

  describe('DEFAULT_AUTOACK_MATRIX', () => {
    it('has all six cells fully off', () => {
      for (const cell of AUTOACK_CELLS) {
        expect(DEFAULT_AUTOACK_MATRIX[cell.id]).toEqual({ reply: false, tapback: false, replyDm: false });
      }
    });
  });

  describe('cellServerKeyPrefix', () => {
    it('capitalizes the first letter of each cell id', () => {
      expect(cellServerKeyPrefix('channelZeroHop')).toBe('autoAckChannelZeroHop');
      expect(cellServerKeyPrefix('channelMultiHop')).toBe('autoAckChannelMultiHop');
      expect(cellServerKeyPrefix('directZeroHop')).toBe('autoAckDirectZeroHop');
      expect(cellServerKeyPrefix('directMultiHop')).toBe('autoAckDirectMultiHop');
      expect(cellServerKeyPrefix('channelIp')).toBe('autoAckChannelIp');
      expect(cellServerKeyPrefix('directIp')).toBe('autoAckDirectIp');
    });
  });

  describe('matrixToSettings', () => {
    it('emits exactly the 18 known key names', () => {
      const settings = matrixToSettings(DEFAULT_AUTOACK_MATRIX);
      expect(Object.keys(settings).sort()).toEqual([...ALL_KEYS].sort());
    });

    it('serializes a pre-#5796 matrix with no Ip cells as Ip off', () => {
      const legacy = {
        channelZeroHop: { reply: true, tapback: false, replyDm: false },
        channelMultiHop: { reply: true, tapback: false, replyDm: false },
        directZeroHop: { reply: false, tapback: false, replyDm: false },
        directMultiHop: { reply: false, tapback: false, replyDm: false },
      } as unknown as AutoAckMatrix;
      const s = matrixToSettings(legacy);
      expect(s.autoAckChannelIpReplyEnabled).toBe('false');
      expect(s.autoAckDirectIpTapbackEnabled).toBe('false');
      expect(s.autoAckChannelMultiHopReplyEnabled).toBe('true');
    });

    it('maps booleans to the strings true/false', () => {
      const m: AutoAckMatrix = {
        channelZeroHop: { reply: true, tapback: false, replyDm: true },
        channelMultiHop: { reply: false, tapback: true, replyDm: false },
        directZeroHop: { reply: true, tapback: true, replyDm: true },
        directMultiHop: { reply: false, tapback: false, replyDm: false },
        channelIp: { reply: true, tapback: false, replyDm: true },
        directIp: { reply: false, tapback: true, replyDm: false },
      };
      const s = matrixToSettings(m);
      expect(s.autoAckChannelIpReplyEnabled).toBe('true');
      expect(s.autoAckChannelIpReplyDmEnabled).toBe('true');
      expect(s.autoAckDirectIpTapbackEnabled).toBe('true');
      expect(s.autoAckDirectIpReplyEnabled).toBe('false');
      expect(s.autoAckChannelZeroHopReplyEnabled).toBe('true');
      expect(s.autoAckChannelZeroHopTapbackEnabled).toBe('false');
      expect(s.autoAckChannelZeroHopReplyDmEnabled).toBe('true');
      expect(s.autoAckChannelMultiHopTapbackEnabled).toBe('true');
      expect(s.autoAckDirectZeroHopReplyDmEnabled).toBe('true');
      expect(s.autoAckDirectMultiHopReplyEnabled).toBe('false');
    });

    it('every emitted value is the string "true" or "false"', () => {
      const m: AutoAckMatrix = {
        channelZeroHop: { reply: true, tapback: false, replyDm: true },
        channelMultiHop: { reply: true, tapback: true, replyDm: true },
        directZeroHop: { reply: false, tapback: true, replyDm: false },
        directMultiHop: { reply: true, tapback: false, replyDm: true },
        channelIp: { reply: false, tapback: true, replyDm: false },
        directIp: { reply: true, tapback: true, replyDm: true },
      };
      for (const value of Object.values(matrixToSettings(m))) {
        expect(value === 'true' || value === 'false').toBe(true);
      }
    });
  });

  describe('settingsToMatrix', () => {
    it('returns the default (all off) matrix for an empty settings object', () => {
      expect(settingsToMatrix({})).toEqual(DEFAULT_AUTOACK_MATRIX);
    });

    it('treats missing keys as false', () => {
      const m = settingsToMatrix({ autoAckChannelZeroHopReplyEnabled: 'true' });
      expect(m.channelZeroHop.reply).toBe(true);
      expect(m.channelZeroHop.tapback).toBe(false);
      expect(m.channelZeroHop.replyDm).toBe(false);
      expect(m.directMultiHop).toEqual({ reply: false, tapback: false, replyDm: false });
      // #5796: Ip cells are unset on every existing install and read as off.
      expect(m.channelIp).toEqual({ reply: false, tapback: false, replyDm: false });
      expect(m.directIp).toEqual({ reply: false, tapback: false, replyDm: false });
    });

    it('accepts both string "true" and boolean true', () => {
      const m = settingsToMatrix({
        autoAckChannelZeroHopReplyEnabled: 'true',
        autoAckChannelMultiHopTapbackEnabled: true,
      });
      expect(m.channelZeroHop.reply).toBe(true);
      expect(m.channelMultiHop.tapback).toBe(true);
    });

    it('treats non-true values (e.g. "false", "1", undefined, null) as false', () => {
      const m = settingsToMatrix({
        autoAckChannelZeroHopReplyEnabled: 'false',
        autoAckChannelZeroHopTapbackEnabled: '1',
        autoAckChannelZeroHopReplyDmEnabled: undefined,
        autoAckChannelMultiHopReplyEnabled: null,
        autoAckDirectZeroHopReplyEnabled: 0,
      });
      expect(m.channelZeroHop).toEqual({ reply: false, tapback: false, replyDm: false });
      expect(m.channelMultiHop.reply).toBe(false);
      expect(m.directZeroHop.reply).toBe(false);
    });
  });

  describe('round-trip', () => {
    it('matrixToSettings → settingsToMatrix reproduces the original matrix', () => {
      const m: AutoAckMatrix = {
        channelZeroHop: { reply: true, tapback: false, replyDm: true },
        channelMultiHop: { reply: false, tapback: true, replyDm: false },
        directZeroHop: { reply: true, tapback: true, replyDm: false },
        directMultiHop: { reply: false, tapback: false, replyDm: true },
        channelIp: { reply: true, tapback: true, replyDm: false },
        directIp: { reply: false, tapback: true, replyDm: true },
      };
      expect(settingsToMatrix(matrixToSettings(m))).toEqual(m);
    });

    it('round-trips the default matrix', () => {
      expect(settingsToMatrix(matrixToSettings(DEFAULT_AUTOACK_MATRIX))).toEqual(DEFAULT_AUTOACK_MATRIX);
    });
  });
});
