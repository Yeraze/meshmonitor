/**
 * @vitest-environment jsdom
 *
 * #5824: "Show MQTT/Bridge Messages" is per source. Each source reads its own
 * cached value, the server copy wins once it loads, and a toggle saves to the
 * server with that source's id.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));
vi.mock('../services/api', () => ({
  default: { get: getMock, post: postMock },
}));

import { UIProvider, useUI } from './UIContext';

function Probe() {
  const { showMqttMessages, setShowMqttMessages } = useUI();
  return (
    <button data-testid="toggle" onClick={() => setShowMqttMessages(!showMqttMessages)}>
      {String(showMqttMessages)}
    </button>
  );
}

function renderAt(sourceId: string) {
  return render(
    <MemoryRouter initialEntries={[`/source/${sourceId}/channels`]}>
      <Routes>
        <Route
          path="source/:sourceId/*"
          element={
            <UIProvider>
              <Probe />
            </UIProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('UIContext showMqttMessages per source (#5824)', () => {
  beforeEach(() => {
    localStorage.clear();
    getMock.mockReset();
    postMock.mockReset();
    postMock.mockResolvedValue({ success: true });
  });

  it('reads the cached value for this source, not another source', () => {
    getMock.mockReturnValue(new Promise(() => {}));
    localStorage.setItem('showMqttMessages:src-a', 'true');
    localStorage.setItem('showMqttMessages:src-b', 'false');

    renderAt('src-b');
    expect(screen.getByTestId('toggle').textContent).toBe('false');
  });

  it('falls back to the legacy global key when this source has no value', () => {
    getMock.mockReturnValue(new Promise(() => {}));
    localStorage.setItem('showMqttMessages', 'true');

    renderAt('src-a');
    expect(screen.getByTestId('toggle').textContent).toBe('true');
  });

  it('applies the server value once it loads', async () => {
    getMock.mockResolvedValue({ preferences: { showMqttMessagesBySource: { 'src-a': true } } });

    renderAt('src-a');
    await waitFor(() => expect(screen.getByTestId('toggle').textContent).toBe('true'));
    expect(localStorage.getItem('showMqttMessages:src-a')).toBe('true');
  });

  it('keeps the local value when the server has none for this source', async () => {
    localStorage.setItem('showMqttMessages:src-a', 'true');
    getMock.mockResolvedValue({ preferences: { showMqttMessagesBySource: { 'src-b': false } } });

    renderAt('src-a');
    await act(async () => {});
    expect(screen.getByTestId('toggle').textContent).toBe('true');
  });

  it('saves a toggle to the server and the local cache under this source only', async () => {
    getMock.mockResolvedValue({ preferences: null });

    renderAt('src-a');
    fireEvent.click(screen.getByTestId('toggle'));

    expect(screen.getByTestId('toggle').textContent).toBe('true');
    expect(postMock).toHaveBeenCalledWith('/api/user/map-preferences', { showMqttMessages: true, sourceId: 'src-a' });
    expect(localStorage.getItem('showMqttMessages:src-a')).toBe('true');
    expect(localStorage.getItem('showMqttMessages')).toBeNull();
  });

  it('does not let a slow server read undo a toggle the user already made', async () => {
    let resolveGet: (v: unknown) => void = () => {};
    getMock.mockReturnValue(new Promise((r) => { resolveGet = r; }));

    renderAt('src-a');
    fireEvent.click(screen.getByTestId('toggle'));
    expect(screen.getByTestId('toggle').textContent).toBe('true');

    await act(async () => {
      resolveGet({ preferences: { showMqttMessagesBySource: { 'src-a': false } } });
    });
    expect(screen.getByTestId('toggle').textContent).toBe('true');
  });
});
