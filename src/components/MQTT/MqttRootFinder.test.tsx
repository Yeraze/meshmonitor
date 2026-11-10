/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn(), put: vi.fn(), patch: vi.fn() }));
vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return { ...actual, default: api };
});

import { ApiError } from '../../services/api';
import { MqttRootFinder } from './MqttRootFinder';
import { MqttRootFieldError } from './MqttRootFieldError';

const view = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    status: 'sampling',
    elapsedMs: 12_000,
    durationMs: 60_000,
    regionFloor: true,
    hasLocation: false,
    ladder: [{ root: 'msh/US', kind: 'region', heard: true, nodes: 40, messages: 300, floor: true }],
    community: [{ root: 'msh/US/IL/Chi', name: 'Chi', heard: false }],
    heard: [
      { root: 'msh/US/WA', nodes: 3, messages: 20, depth: 3, tier: 3, retainedOnly: true, floor: false, nearestKm: 12 },
    ],
    ...over,
  },
});

function setup(props: Partial<React.ComponentProps<typeof MqttRootFinder>> = {}) {
  const onPickRoot = vi.fn();
  render(
    <MqttRootFinder
      context="bridge"
      sourceId="src1"
      getTarget={() => ({ broker: { url: 'mqtt://b.test:1883' }, username: 'u', password: 'p' })}
      defaultRegionRoot="msh/US"
      currentRoot="msh/US/old"
      onPickRoot={onPickRoot}
      {...props}
    />,
  );
  return { onPickRoot };
}

const open = () => fireEvent.click(screen.getByRole('button', { name: /mqtt_root_finder.button|Find topics/ }));
const startBtn = () => screen.getByRole('button', { name: /mqtt_root_finder.start|Listen for 60/ });

async function startAndPoll() {
  open();
  await act(async () => {
    fireEvent.click(startBtn());
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  api.get.mockReset();
  api.post.mockReset();
  api.delete.mockReset();
  api.post.mockResolvedValue({ success: true, data: { sampleId: 's1', durationMs: 60_000 } });
  api.get.mockResolvedValue(view());
  api.delete.mockResolvedValue({ success: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MqttRootFinder', () => {
  it('starts a sample with the form target and shows the three sections with badges', async () => {
    setup();
    await startAndPoll();
    expect(api.post).toHaveBeenCalledWith('/api/mqtt/root-finder/samples', {
      context: 'bridge',
      regionRoot: 'msh/US',
      broker: { url: 'mqtt://b.test:1883' },
      sourceId: 'src1',
      username: 'u',
      password: 'p',
    });
    expect(screen.getByText('msh/US/IL/Chi')).toBeTruthy();
    expect(screen.getByText('msh/US/WA')).toBeTruthy();
    // floor + not heard + retained badges
    expect(screen.getAllByText(/mqtt_root_finder.floor|at least/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/mqtt_root_finder.not_heard|not heard/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/mqtt_root_finder.retained$|^retained$/).length).toBeGreaterThan(0);
  });

  it('shows where the community directory came from (#6337)', async () => {
    api.get.mockResolvedValue(view({ directory: { source: 'bundled' } }));
    setup();
    await startAndPoll();
    expect(screen.getByText(/mqtt_root_finder.directory_bundled|bundled copy/)).toBeTruthy();
  });

  it('shows an updated directory footnote for a live copy (#6337)', async () => {
    api.get.mockResolvedValue(view({ directory: { source: 'live', fetchedAt: Date.UTC(2026, 10, 1) } }));
    setup();
    await startAndPoll();
    expect(screen.getByText(/mqtt_root_finder.directory_updated|Root directory: updated/)).toBeTruthy();
  });

  it('picking a row calls onPickRoot and makes no save call', async () => {
    const { onPickRoot } = setup();
    await startAndPoll();
    fireEvent.click(screen.getByText('msh/US/WA'));
    expect(onPickRoot).toHaveBeenCalledWith('msh/US/WA');
    // Only the sample start was posted: nothing else (no save, no put/patch).
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('cancels a running sample when it unmounts', async () => {
    setup();
    await startAndPoll();
    cleanup();
    expect(api.delete).toHaveBeenCalledWith('/api/mqtt/root-finder/samples/s1');
  });

  it('closing the sheet cancels a running sample', async () => {
    setup();
    await startAndPoll();
    fireEvent.click(document.querySelector('.modal-close') as Element);
    expect(api.delete).toHaveBeenCalledWith('/api/mqtt/root-finder/samples/s1');
  });

  it('shows validation for a custom root and disables Use', () => {
    const { onPickRoot } = setup();
    open();
    const input = document.getElementById('mqtt-root-finder-custom') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'msh/US/+' } });
    expect(screen.getByRole('alert').textContent).toMatch(/WILDCARD|\+ or #/);
    const use = screen.getByRole('button', { name: /use_custom|Use this root/ }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'msh/US/WA' } });
    expect(use.disabled).toBe(false);
    fireEvent.click(use);
    expect(onPickRoot).toHaveBeenCalledWith('msh/US/WA');
  });

  it('shows a 429 back-off and disables Start for the retry window', async () => {
    api.post.mockRejectedValueOnce(
      new ApiError('busy', 429, { code: 'ROOT_FINDER_BUSY', retryAfterSeconds: 30 }),
    );
    setup();
    open();
    await act(async () => {
      fireEvent.click(startBtn());
    });
    expect(screen.getByRole('alert').textContent).toMatch(/busy|30/);
    expect((startBtn() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect((startBtn() as HTMLButtonElement).disabled).toBe(false);
  });

  it('asks for a broker when the form has none', () => {
    setup({ getTarget: () => null });
    open();
    fireEvent.click(startBtn());
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/broker/i);
  });

  it('shows a coarse error code from a failed sample', async () => {
    api.get.mockResolvedValue(view({ status: 'failed', error: 'UNREACHABLE', heard: [], community: [], ladder: [] }));
    setup();
    await startAndPoll();
    expect(screen.getByRole('alert').textContent).toMatch(/UNREACHABLE|reach the broker/);
  });
});

describe('MqttRootFinder (MeshCore regions, #6335)', () => {
  const mcView = (over: Record<string, unknown> = {}) =>
    view({
      protocol: 'meshcore',
      regionFloor: false,
      ladder: [],
      community: [],
      heard: [
        { root: 'MCO', nodes: 4, messages: 9, depth: 1, tier: 3, retainedOnly: true, floor: false },
        { root: 'TPA', nodes: 0, messages: 2, depth: 1, tier: 3, retainedOnly: true, floor: false },
      ],
      ...over,
    });

  const mcSetup = (props: Partial<React.ComponentProps<typeof MqttRootFinder>> = {}) =>
    setup({
      protocol: 'meshcore',
      context: 'meshcore_mqtt',
      defaultRegionRoot: '',
      currentRoot: 'XYZ',
      getTarget: () => ({ broker: { url: 'wss://b.test:443' }, rejectUnauthorized: false }),
      ...props,
    });

  const mcOpen = () => fireEvent.click(screen.getByRole('button', { name: /meshcore_button|Find regions/ }));

  it('starts without a region root, hides Search under, ladder, community and the retained badge', async () => {
    api.get.mockResolvedValue(mcView());
    mcSetup();
    mcOpen();
    expect(document.getElementById('mqtt-root-finder-region')).toBeNull();
    await act(async () => {
      fireEvent.click(startBtn());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(api.post).toHaveBeenCalledWith('/api/mqtt/root-finder/samples', {
      context: 'meshcore_mqtt',
      broker: { url: 'wss://b.test:443' },
      sourceId: 'src1',
      rejectUnauthorized: false,
    });
    expect(screen.getByText('MCO')).toBeTruthy();
    expect(screen.getByText('TPA')).toBeTruthy();
    expect(screen.getByText(/regions_heading|Active regions/)).toBeTruthy();
    expect(screen.queryByText(/mqtt_root_finder.suggested|^Suggested$/)).toBeNull();
    expect(screen.queryByText(/mqtt_root_finder.community|^Community$/)).toBeNull();
    expect(screen.queryAllByText(/mqtt_root_finder.retained$|^retained$/)).toHaveLength(0);
    expect(screen.getAllByText(/observers|observer online/).length).toBeGreaterThan(0);
  });

  it('picking a region calls onPickRoot with the code and saves nothing', async () => {
    api.get.mockResolvedValue(mcView());
    const { onPickRoot } = mcSetup();
    mcOpen();
    await act(async () => {
      fireEvent.click(startBtn());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    fireEvent.click(screen.getByText('MCO'));
    expect(onPickRoot).toHaveBeenCalledWith('MCO');
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('validates a typed region code and upper-cases it on pick', () => {
    const { onPickRoot } = mcSetup();
    mcOpen();
    const input = document.getElementById('mqtt-root-finder-custom') as HTMLInputElement;
    const use = screen.getByRole('button', { name: /use_custom|Use this root/ }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: 'meshcore/MCO' } });
    expect(screen.getByRole('alert').textContent).toMatch(/meshcore_custom_invalid|letters/);
    expect(use.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'mco' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(use.disabled).toBe(false);
    fireEvent.click(use);
    expect(onPickRoot).toHaveBeenCalledWith('MCO');
  });

  it('adds a MeshCore hint to a denied subscribe', async () => {
    api.get.mockResolvedValue(mcView({ status: 'failed', error: 'SUBSCRIBE_DENIED', heard: [] }));
    mcSetup();
    mcOpen();
    await act(async () => {
      fireEvent.click(startBtn());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole('alert').textContent).toMatch(/meshcore_subscribe_denied_hint|operator/);
  });
});

describe('MqttRootFieldError', () => {
  it('renders nothing for a valid or empty root and a message otherwise', () => {
    const { container, rerender } = render(<MqttRootFieldError value="msh/US" />);
    expect(container.textContent).toBe('');
    rerender(<MqttRootFieldError value="" />);
    expect(container.textContent).toBe('');
    rerender(<MqttRootFieldError value="msh/US/2" />);
    expect(container.textContent).toMatch(/ENDS_WITH_2|\/2/);
  });
});
