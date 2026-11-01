// @vitest-environment jsdom
/**
 * MapContext — `colorNodesBySource` server round-trip (#6125).
 *
 * Mirrors the other map-preference toggles: a set POSTs the preference to the
 * server, and a server-loaded value restores it on mount. Default is FALSE
 * (opt-in ring).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';
import { MapProvider, useMapContext } from './MapContext';

// --- mocks -----------------------------------------------------------------

vi.mock('../services/api', () => ({
  default: { getBaseUrl: vi.fn().mockResolvedValue('') },
}));

vi.mock('./CsrfContext', () => ({
  useCsrf: () => ({ getToken: () => 'test-csrf', refreshToken: vi.fn() }),
}));

// Capture POST bodies and script the GET response per test.
let loadedPreferences: Record<string, unknown> | null = null;
const postedBodies: Array<Record<string, unknown>> = [];

function installFetch() {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      postedBodies.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, json: async () => ({ success: true }), text: async () => '' } as unknown as Response;
    }
    // GET load
    return {
      ok: true,
      status: 200,
      json: async () => ({ preferences: loadedPreferences }),
    } as unknown as Response;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

function Consumer() {
  const { colorNodesBySource, setColorNodesBySource } = useMapContext();
  return (
    <div>
      <span data-testid="value">{String(colorNodesBySource)}</span>
      <button onClick={() => setColorNodesBySource(true)}>enable</button>
    </div>
  );
}

describe('MapContext colorNodesBySource (#6125)', () => {
  beforeEach(() => {
    loadedPreferences = null;
    postedBodies.length = 0;
    installFetch();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to false and POSTs colorNodesBySource:true when set', async () => {
    render(
      <MapProvider>
        <Consumer />
      </MapProvider>,
    );

    // Default off until the server says otherwise.
    expect(screen.getByTestId('value').textContent).toBe('false');

    await act(async () => {
      screen.getByText('enable').click();
    });

    expect(screen.getByTestId('value').textContent).toBe('true');
    await waitFor(() => {
      expect(postedBodies.some((b) => b.colorNodesBySource === true)).toBe(true);
    });
  });

  it('restores colorNodesBySource:true from a server-loaded preference', async () => {
    loadedPreferences = { colorNodesBySource: true };

    render(
      <MapProvider>
        <Consumer />
      </MapProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('true');
    });
  });
});
