/**
 * MeshCorePathHashSection and MeshCoreDefaultScopeSection: the two saved
 * device settings that moved from the MeshCore Settings tab to Device
 * Configuration (#5683 follow-up).
 *
 * Covers: each loads its value with a read, saves the same value through the
 * same action only when its own Save is pressed, keeps an unsaved edit while
 * the other section saves, is gated on configuration:write, and (the region
 * sweep, which transmits) never runs on mount, holds in receive-only mode and
 * is gated on nodes:write.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeshCorePathHashSection } from './MeshCorePathHashSection';
import { MeshCoreDefaultScopeSection } from './MeshCoreDefaultScopeSection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

const TOOLTIP = 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.';

function makeActions(overrides: Record<string, unknown> = {}) {
  return {
    getDefaultPathHashSize: vi.fn().mockResolvedValue(1),
    setDefaultPathHashSize: vi.fn().mockImplementation(async (size: number) => size),
    getDefaultScope: vi.fn().mockResolvedValue('bayern'),
    setDefaultScope: vi.fn().mockImplementation(async (scope: string) => scope.trim().replace(/^#/, '')),
    discoverRegions: vi.fn().mockResolvedValue({ regions: ['muenchen', 'augsburg'], noZeroHopRepeaters: false }),
    fetchSavedRegions: vi.fn().mockResolvedValue([{ id: 1, name: 'augsburg' }]),
    addSavedRegion: vi.fn().mockImplementation(async (name: string) => ({ id: 2, name })),
    ...overrides,
  };
}

interface Options {
  connected?: boolean;
  receiveOnly?: boolean;
  canWriteConfig?: boolean;
  canWriteNodes?: boolean;
  otherSweepRunning?: boolean;
}

function renderBoth(actions = makeActions(), options: Options = {}) {
  const common = {
    connected: options.connected ?? true,
    actions: actions as never,
    canWriteConfig: options.canWriteConfig ?? true,
  };
  render(
    <>
      <MeshCorePathHashSection {...common} />
      <MeshCoreDefaultScopeSection
        {...common}
        receiveOnly={options.receiveOnly}
        canWriteNodes={options.canWriteNodes ?? true}
        otherSweepRunning={options.otherSweepRunning}
      />
    </>,
  );
  return actions;
}

const pathHashSelect = () => screen.getByRole('combobox', { name: 'Default path hash size' }) as HTMLSelectElement;
const savePathHash = () => screen.getByRole('button', { name: 'Save path hash size' });
const scopeInput = () => screen.getByRole('textbox', { name: 'Default region / scope' }) as HTMLInputElement;
const saveScope = () => screen.getByRole('button', { name: 'Save default scope' });
const discoverRegions = () => screen.getByRole('button', { name: 'Discover regions from repeaters' });

async function loaded(actions: ReturnType<typeof makeActions>) {
  await waitFor(() => expect(scopeInput().value).toBe('bayern'));
  await waitFor(() => expect(actions.getDefaultPathHashSize).toHaveBeenCalled());
}

describe('moved MeshCore device settings: load', () => {
  it('reads both values on mount and writes or transmits nothing', async () => {
    const actions = renderBoth();
    await loaded(actions);
    expect(pathHashSelect().value).toBe('1');
    for (const name of ['setDefaultPathHashSize', 'setDefaultScope', 'discoverRegions', 'addSavedRegion'] as const) {
      expect(actions[name], name).not.toHaveBeenCalled();
    }
  });

  it('reads nothing from the device config while disconnected', () => {
    const actions = renderBoth(makeActions(), { connected: false });
    expect(actions.getDefaultPathHashSize).not.toHaveBeenCalled();
    expect(actions.getDefaultScope).not.toHaveBeenCalled();
    expect(pathHashSelect()).toBeDisabled();
    expect(scopeInput()).toBeDisabled();
  });

  it('both Save buttons start disabled: nothing is dirty', async () => {
    await loaded(renderBoth());
    expect(savePathHash()).toBeDisabled();
    expect(saveScope()).toBeDisabled();
  });
});

describe('moved MeshCore device settings: save', () => {
  it('changing the path hash dropdown writes nothing until Save, then sends the size', async () => {
    const user = userEvent.setup();
    const actions = renderBoth();
    await loaded(actions);
    await user.selectOptions(pathHashSelect(), '2');
    expect(actions.setDefaultPathHashSize).not.toHaveBeenCalled();
    await user.click(savePathHash());
    expect(actions.setDefaultPathHashSize).toHaveBeenCalledTimes(1);
    expect(actions.setDefaultPathHashSize).toHaveBeenCalledWith(2);
    await waitFor(() => expect(savePathHash()).toBeDisabled());
  });

  it('typing a scope writes nothing until Save, then sends the text as typed', async () => {
    const user = userEvent.setup();
    const actions = renderBoth();
    await loaded(actions);
    await user.clear(scopeInput());
    await user.type(scopeInput(), '#muenchen');
    expect(actions.setDefaultScope).not.toHaveBeenCalled();
    await user.click(saveScope());
    expect(actions.setDefaultScope).toHaveBeenCalledTimes(1);
    expect(actions.setDefaultScope).toHaveBeenCalledWith('#muenchen');
    await waitFor(() => expect(scopeInput().value).toBe('muenchen'));
  });

  it('saving one section neither sends nor loses the unsaved edit in the other', async () => {
    const user = userEvent.setup();
    const actions = renderBoth();
    await loaded(actions);
    await user.clear(scopeInput());
    await user.type(scopeInput(), 'augsburg');
    await user.selectOptions(pathHashSelect(), '3');

    await user.click(savePathHash());
    await waitFor(() => expect(savePathHash()).toBeDisabled());
    expect(actions.setDefaultScope).not.toHaveBeenCalled();
    expect(scopeInput().value).toBe('augsburg');
    expect(saveScope()).not.toBeDisabled();

    await user.click(saveScope());
    expect(actions.setDefaultScope).toHaveBeenCalledWith('augsburg');
    expect(actions.setDefaultPathHashSize).toHaveBeenCalledTimes(1);
  });

  it('a failed save keeps the edit for another try', async () => {
    const user = userEvent.setup();
    const actions = renderBoth(makeActions({ setDefaultScope: vi.fn().mockResolvedValue(null) }));
    await loaded(actions);
    await user.clear(scopeInput());
    await user.type(scopeInput(), 'augsburg');
    await user.click(saveScope());
    await waitFor(() => expect(saveScope()).not.toBeDisabled());
    expect(scopeInput().value).toBe('augsburg');
  });
});

describe('moved MeshCore device settings: gated on configuration:write', () => {
  it('without it the fields and both Saves are disabled and nothing is sent', async () => {
    const actions = renderBoth(makeActions(), { canWriteConfig: false });
    await loaded(actions);
    expect(pathHashSelect()).toBeDisabled();
    expect(scopeInput()).toBeDisabled();
    expect(savePathHash()).toBeDisabled();
    expect(saveScope()).toBeDisabled();
  });

  it('with it they are editable', async () => {
    await loaded(renderBoth());
    expect(pathHashSelect()).not.toBeDisabled();
    expect(scopeInput()).not.toBeDisabled();
  });
});

describe('Discover regions from repeaters: transmits, so it only runs on a press', () => {
  it('is not run by mounting, typing a scope or saving', async () => {
    const user = userEvent.setup();
    const actions = renderBoth();
    await loaded(actions);
    await user.type(scopeInput(), 'x');
    await user.click(saveScope());
    await user.selectOptions(pathHashSelect(), '2');
    await user.click(savePathHash());
    expect(actions.discoverRegions).not.toHaveBeenCalled();
  });

  it('runs once per press, with no argument, and offers what came back', async () => {
    const user = userEvent.setup();
    const actions = renderBoth();
    await loaded(actions);
    await user.click(discoverRegions());
    expect(actions.discoverRegions).toHaveBeenCalledTimes(1);
    expect(actions.discoverRegions).toHaveBeenCalledWith();
    expect(await screen.findByRole('button', { name: 'muenchen' })).toBeInTheDocument();
    // Picking a chip only fills the field: the scope is not written.
    await user.click(screen.getByRole('button', { name: 'muenchen' }));
    expect(scopeInput().value).toBe('muenchen');
    expect(actions.setDefaultScope).not.toHaveBeenCalled();
  });

  it('marks a region already in the saved list and saves another to it', async () => {
    const user = userEvent.setup();
    const actions = renderBoth();
    await loaded(actions);
    await user.click(discoverRegions());
    await screen.findByRole('button', { name: 'muenchen' });
    expect(screen.getByTitle('Already in saved regions')).toBeDisabled();
    await user.click(screen.getByTitle('Save "muenchen" to your regions list'));
    expect(actions.addSavedRegion).toHaveBeenCalledWith('muenchen');
  });

  it('is held in receive-only mode, with the control tooltip', async () => {
    const actions = renderBoth(makeActions(), { receiveOnly: true });
    await loaded(actions);
    expect(discoverRegions()).toBeDisabled();
    expect(discoverRegions()).toHaveAttribute('title', TOOLTIP);
    // Saving the scope is a settings write, not a transmission.
    expect(scopeInput()).not.toBeDisabled();
  });

  it('is disabled with the reason without nodes:write, whatever configuration grant is held', async () => {
    const user = userEvent.setup();
    const actions = renderBoth(makeActions(), { canWriteNodes: false });
    await loaded(actions);
    expect(discoverRegions()).toBeDisabled();
    expect(discoverRegions()).toHaveAttribute('title', 'This needs the Nodes write permission on this source.');
    await user.click(discoverRegions());
    expect(actions.discoverRegions).not.toHaveBeenCalled();
    expect(scopeInput()).not.toBeDisabled();
  });

  it('is held while a node sweep runs', async () => {
    const actions = renderBoth(makeActions(), { otherSweepRunning: true });
    await loaded(actions);
    expect(discoverRegions()).toBeDisabled();
  });
});
