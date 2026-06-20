import { describe, it, expect } from 'vitest';
import {
  AUTOACK_CELLS,
  DEFAULT_AUTOACK_MATRIX,
  cellServerKeyPrefix,
  matrixToSettings,
  settingsToMatrix,
  type AutoAckMatrix,
} from './autoAckMatrix';

const ALL_12_KEYS = [
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
];

describe('autoAckMatrix', () => {
  describe('AUTOACK_CELLS', () => {
    it('has exactly four cells in the expected order', () => {
      expect(AUTOACK_CELLS.map(c => c.id)).toEqual([
        'channelZeroHop',
        'channelMultiHop',
        'directZeroHop',
        'directMultiHop',
      ]);
    });

    it('maps each cell to correct type/hop', () => {
      const byId = Object.fromEntries(AUTOACK_CELLS.map(c => [c.id, c]));
      expect(byId.channelZeroHop).toMatchObject({ type: 'channel', hop: 'zeroHop' });
      expect(byId.channelMultiHop).toMatchObject({ type: 'channel', hop: 'multiHop' });
      expect(byId.directZeroHop).toMatchObject({ type: 'direct', hop: 'zeroHop' });
      expect(byId.directMultiHop).toMatchObject({ type: 'direct', hop: 'multiHop' });
    });

    it('gives every cell a non-empty human label', () => {
      for (const cell of AUTOACK_CELLS) {
        expect(typeof cell.label).toBe('string');
        expect(cell.label.length).toBeGreaterThan(0);
      }
    });
  });

  describe('DEFAULT_AUTOACK_MATRIX', () => {
    it('has all four cells fully off', () => {
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
    });
  });

  describe('matrixToSettings', () => {
    it('emits exactly the 12 known key names', () => {
      const settings = matrixToSettings(DEFAULT_AUTOACK_MATRIX);
      expect(Object.keys(settings).sort()).toEqual([...ALL_12_KEYS].sort());
    });

    it('maps booleans to the strings true/false', () => {
      const m: AutoAckMatrix = {
        channelZeroHop: { reply: true, tapback: false, replyDm: true },
        channelMultiHop: { reply: false, tapback: true, replyDm: false },
        directZeroHop: { reply: true, tapback: true, replyDm: true },
        directMultiHop: { reply: false, tapback: false, replyDm: false },
      };
      const s = matrixToSettings(m);
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
      };
      expect(settingsToMatrix(matrixToSettings(m))).toEqual(m);
    });

    it('round-trips the default matrix', () => {
      expect(settingsToMatrix(matrixToSettings(DEFAULT_AUTOACK_MATRIX))).toEqual(DEFAULT_AUTOACK_MATRIX);
    });
  });
});
