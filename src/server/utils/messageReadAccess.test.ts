/**
 * Tests for `resolveMessageReadAccess` (#5101 WP4) — the permission logic
 * extracted verbatim from `GET /api/messages`, now shared with
 * `GET /api/messages/counts`. `hasPermission` and
 * `getUserReadableVirtualChannelIds` are stubbed so these exercise only the
 * combination logic in `canReadChannel`, not the underlying grant storage
 * (that's covered by the real-harness route tests).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import type { User } from '../../types/auth.js';

// Per-test-configurable permission table: resource -> allowed.
let granted: Set<string>;

vi.mock('../auth/authMiddleware.js', () => ({
  hasPermission: vi.fn(async (user: unknown, resource: string) => granted.has(resource)),
}));

let readableVirtual: Set<number> | 'all';

vi.mock('./virtualChannelPermissions.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getUserReadableVirtualChannelIds: vi.fn(async () => readableVirtual),
  };
});

import { resolveMessageReadAccess } from './messageReadAccess.js';

const USER: User = { id: 1, username: 'limited', isAdmin: false } as User;
const ADMIN: User = { id: 2, username: 'admin', isAdmin: true } as User;

describe('resolveMessageReadAccess', () => {
  beforeEach(() => {
    granted = new Set();
    readableVirtual = new Set();
  });

  describe('canReadChannel — DM (-1)', () => {
    it('requires messages:read', async () => {
      const access = await resolveMessageReadAccess(USER, 'src-a');
      expect(access.canReadChannel(-1)).toBe(false);

      granted.add('messages');
      const access2 = await resolveMessageReadAccess(USER, 'src-a');
      expect(access2.canReadChannel(-1)).toBe(true);
    });
  });

  describe('canReadChannel — physical channel', () => {
    it('requires BOTH channel_0:read AND the per-channel channel_N:read', async () => {
      // channel_0 alone (the generic gate) is not enough for channel 3.
      granted.add('channel_0');
      const access = await resolveMessageReadAccess(USER, 'src-a');
      expect(access.hasChannelsRead).toBe(true);
      expect(access.canReadChannel(3)).toBe(false);

      // Adding the per-channel grant authorizes it.
      granted.add('channel_3');
      const access2 = await resolveMessageReadAccess(USER, 'src-a');
      expect(access2.canReadChannel(3)).toBe(true);
    });

    it('channel_N alone without the generic channel_0 gate is not enough', async () => {
      granted.add('channel_3');
      const access = await resolveMessageReadAccess(USER, 'src-a');
      expect(access.canReadChannel(3)).toBe(false);
    });
  });

  describe('canReadChannel — virtual channel', () => {
    it('is denied without a per-entry canRead grant', async () => {
      readableVirtual = new Set([5]);
      const access = await resolveMessageReadAccess(USER, 'src-a');
      // Virtual channel db id 9 != granted id 5.
      expect(access.canReadChannel(CHANNEL_DB_OFFSET + 9)).toBe(false);
    });

    it('is allowed with a matching per-entry canRead grant', async () => {
      readableVirtual = new Set([9]);
      const access = await resolveMessageReadAccess(USER, 'src-a');
      expect(access.canReadChannel(CHANNEL_DB_OFFSET + 9)).toBe(true);
    });

    it('does not require channel_0:read or messages:read — virtual-only readers are not blanket-denied', async () => {
      readableVirtual = new Set([9]);
      const access = await resolveMessageReadAccess(USER, 'src-a');
      expect(access.hasChannelsRead).toBe(false);
      expect(access.hasMessagesRead).toBe(false);
      expect(access.canReadAny).toBe(true);
      expect(access.canReadChannel(CHANNEL_DB_OFFSET + 9)).toBe(true);
    });
  });

  describe('admin', () => {
    it('reads every physical channel without explicit grants', async () => {
      const access = await resolveMessageReadAccess(ADMIN, 'src-a');
      expect(access.isAdmin).toBe(true);
      expect(access.hasChannelsRead).toBe(true);
      expect(access.hasMessagesRead).toBe(true);
      for (let id = 0; id <= 7; id++) expect(access.canReadChannel(id)).toBe(true);
    });

    it('reads every virtual channel regardless of readableVirtual contents', async () => {
      readableVirtual = new Set(); // getUserReadableVirtualChannelIds resolves 'all' for real admins;
      // this stub still returns the configured value, so pin 'all' explicitly here.
      readableVirtual = 'all';
      const access = await resolveMessageReadAccess(ADMIN, 'src-a');
      expect(access.canReadChannel(CHANNEL_DB_OFFSET + 42)).toBe(true);
    });

    it('reads DMs', async () => {
      const access = await resolveMessageReadAccess(ADMIN, 'src-a');
      expect(access.canReadChannel(-1)).toBe(true);
    });
  });

  describe('canReadAny', () => {
    it('is false when the caller has no channel, message, or virtual-channel grant', async () => {
      const access = await resolveMessageReadAccess(USER, 'src-a');
      expect(access.canReadAny).toBe(false);
    });

    it('is true from messages:read alone', async () => {
      granted.add('messages');
      const access = await resolveMessageReadAccess(USER, 'src-a');
      expect(access.canReadAny).toBe(true);
    });

    it('is false for an unauthenticated caller (user undefined) with no virtual grants', async () => {
      const access = await resolveMessageReadAccess(undefined, 'src-a');
      expect(access.canReadAny).toBe(false);
      expect(access.canReadChannel(-1)).toBe(false);
    });
  });
});
