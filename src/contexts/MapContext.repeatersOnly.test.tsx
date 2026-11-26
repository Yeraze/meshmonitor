// @vitest-environment jsdom
/** MapContext `showRepeatersOnly` (#5891): default off, persisted locally, storage-safe. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MapProvider, useMapContext } from './MapContext';

vi.mock('../services/api', () => ({
  default: { getBaseUrl: vi.fn().mockResolvedValue('') },
}));

vi.mock('./CsrfContext', () => ({
  useCsrf: () => ({ getToken: () => 'test-csrf', refreshToken: vi.fn() }),
}));

function Consumer() {
  const { showRepeatersOnly, setShowRepeatersOnly } = useMapContext();
  return (
    <div>
      <span data-testid="value">{String(showRepeatersOnly)}</span>
      <button onClick={() => setShowRepeatersOnly(!showRepeatersOnly)}>flip</button>
    </div>
  );
}

const mount = () =>
  render(
    <MapProvider>
      <Consumer />
    </MapProvider>,
  );

describe('MapContext showRepeatersOnly (#5891)', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ preferences: null }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to false', () => {
    mount();
    expect(screen.getByTestId('value').textContent).toBe('false');
  });

  it('persists the setter to localStorage', () => {
    mount();
    fireEvent.click(screen.getByText('flip'));
    expect(screen.getByTestId('value').textContent).toBe('true');
    expect(localStorage.getItem('showRepeatersOnly')).toBe('true');
  });

  it("seeds from 'true'", () => {
    localStorage.setItem('showRepeatersOnly', 'true');
    mount();
    expect(screen.getByTestId('value').textContent).toBe('true');
  });

  it('survives a throwing localStorage on read and write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mount();
    expect(screen.getByTestId('value').textContent).toBe('false');
    fireEvent.click(screen.getByText('flip'));
    expect(screen.getByTestId('value').textContent).toBe('true');
  });
});
