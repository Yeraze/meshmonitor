// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AuthStatus } from '../contexts/AuthContext';
import { AuthContext } from '../contexts/authContextObject';
import { usePublicInstanceView } from './usePublicInstanceView';

const cfg = { enabled: true, hideLongNames: true, hidePublicKeys: false, roundTimestamps: true, hideMessageText: false };
const base = {
  authenticated: false, user: null, permissions: { global: {}, bySource: {} }, channelDbPermissions: {},
  oidcEnabled: false, localAuthDisabled: false, anonymousDisabled: false, customTitle: null, customLogoUrl: null,
} as AuthStatus;

const wrap = (status: AuthStatus | null) => ({ children }: { children: React.ReactNode }) => (
  <AuthContext.Provider value={{ authStatus: status } as never}>{children}</AuthContext.Provider>
);

describe('usePublicInstanceView', () => {
  it('is inactive with no provider', () => {
    const { result } = renderHook(() => usePublicInstanceView());
    expect(result.current).toEqual({ active: false, hideLongNames: false, hidePublicKeys: false, coarseTime: false, hideMessageText: false });
  });
  it('is active for a signed-out viewer with mode on', () => {
    const { result } = renderHook(() => usePublicInstanceView(), { wrapper: wrap({ ...base, publicInstance: cfg }) });
    expect(result.current).toEqual({ active: true, hideLongNames: true, hidePublicKeys: false, coarseTime: true, hideMessageText: false });
  });
  it('is inactive when signed in, mode off, flag absent, or status null', () => {
    for (const s of [
      { ...base, authenticated: true, publicInstance: cfg },
      { ...base, publicInstance: { ...cfg, enabled: false } },
      base,
      null,
    ]) {
      const { result } = renderHook(() => usePublicInstanceView(), { wrapper: wrap(s) });
      expect(result.current.active).toBe(false);
    }
  });
});
