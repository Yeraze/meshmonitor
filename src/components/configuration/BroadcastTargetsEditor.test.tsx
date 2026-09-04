// @vitest-environment jsdom
/**
 * Coverage for the MeshBeacon BroadcastTargetsEditor (issues #4802, #5062). The
 * editor owns no state — it renders the passed array and reports edits through
 * onChange — so these assert the array transforms for add / remove / edit-each-
 * field, plus the two firmware limits that fail silently on the device: the
 * nanopb `max_count:4` cap, and the rule that a target's channel must be a slot
 * the node actually has.
 *
 * The test i18n mock returns the translation KEY (see src/test/setup.ts), so we
 * query controls by their `meshbeacon_config.*` keys rather than English text.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BroadcastTargetsEditor from './BroadcastTargetsEditor';
import { MESH_BEACON_MAX_TARGETS, type BroadcastTarget } from '../admin-commands/useAdminCommandsState';
import type { Channel } from '../../types/device';

/** Two configured slots plus a DISABLED one that must not be offered. */
const CHANNELS: Channel[] = [
  { id: 0, name: '', displayName: 'LongFast', role: 1, uplinkEnabled: false, downlinkEnabled: false },
  { id: 1, name: 'gauntlet', role: 2, uplinkEnabled: false, downlinkEnabled: false },
  { id: 2, name: '', role: 0, uplinkEnabled: false, downlinkEnabled: false },
] as Channel[];

function renderEditor(targets: BroadcastTarget[], channels: Channel[] = CHANNELS) {
  const onChange = vi.fn();
  render(
    <BroadcastTargetsEditor targets={targets} onChange={onChange} disabled={false} channels={channels} />
  );
  return onChange;
}

describe('BroadcastTargetsEditor', () => {
  it('adds a neutral target when "Add target" is clicked', () => {
    const onChange = renderEditor([]);
    fireEvent.click(screen.getByText('meshbeacon_config.target_add'));
    expect(onChange).toHaveBeenCalledWith([{ preset: null, region: 0, channelIndex: null }]);
  });

  it('removes the target at the clicked index', () => {
    const onChange = renderEditor([
      { preset: 6, region: 1, channelIndex: 0 },
      { preset: null, region: 2, channelIndex: null },
    ]);
    const removeButtons = screen.getAllByText('meshbeacon_config.target_remove');
    fireEvent.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith([{ preset: null, region: 2, channelIndex: null }]);
  });

  it('edits a target preset, mapping the empty option back to null', () => {
    const onChange = renderEditor([{ preset: 6, region: 1, channelIndex: 0 }]);
    const presetSelect = screen.getByLabelText('meshbeacon_config.target_preset');
    fireEvent.change(presetSelect, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith([{ preset: null, region: 1, channelIndex: 0 }]);
  });

  it('edits a target region', () => {
    const onChange = renderEditor([{ preset: 6, region: 1, channelIndex: 0 }]);
    const regionSelect = screen.getByLabelText('meshbeacon_config.target_region');
    fireEvent.change(regionSelect, { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith([{ preset: 6, region: 3, channelIndex: 0 }]);
  });

  it('edits a target channel slot, mapping the default option back to null', () => {
    const onChange = renderEditor([{ preset: 6, region: 1, channelIndex: 0 }]);
    const channelSelect = screen.getByLabelText('meshbeacon_config.target_channel');
    fireEvent.change(channelSelect, { target: { value: '1' } });
    expect(onChange).toHaveBeenCalledWith([{ preset: 6, region: 1, channelIndex: 1 }]);

    fireEvent.change(channelSelect, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith([{ preset: 6, region: 1, channelIndex: null }]);
  });

  it('renders one row per target', () => {
    renderEditor([
      { preset: 6, region: 1, channelIndex: 0 },
      { preset: null, region: 2, channelIndex: null },
      { preset: 0, region: 0, channelIndex: 1 },
    ]);
    expect(screen.getAllByText('meshbeacon_config.target_remove')).toHaveLength(3);
  });
});

describe('BroadcastTargetsEditor — channel slot picker (#5062)', () => {
  it('offers only the node\'s configured slots, never a free-form index', () => {
    renderEditor([{ preset: null, region: 0, channelIndex: null }]);
    const channelSelect = screen.getByLabelText('meshbeacon_config.target_channel') as HTMLSelectElement;

    // The control is a <select>, so an index the node lacks cannot be typed.
    expect(channelSelect.tagName).toBe('SELECT');
    const values = Array.from(channelSelect.options).map((option) => option.value);
    // '' = default for preset, plus slots 0 and 1. Slot 2 is role DISABLED.
    expect(values).toEqual(['', '0', '1']);
  });

  it('labels each slot with its index and name', () => {
    renderEditor([{ preset: null, region: 0, channelIndex: null }]);
    const channelSelect = screen.getByLabelText('meshbeacon_config.target_channel') as HTMLSelectElement;
    const labels = Array.from(channelSelect.options).map((option) => option.textContent);
    expect(labels).toContain('0 — LongFast');
    expect(labels).toContain('1 — gauntlet');
  });

  it('surfaces a stored index the node no longer has instead of silently rewriting it', () => {
    renderEditor([{ preset: null, region: 0, channelIndex: 5 }]);
    const channelSelect = screen.getByLabelText('meshbeacon_config.target_channel') as HTMLSelectElement;
    expect(channelSelect.value).toBe('5');
    expect(screen.getByText('meshbeacon_config.target_channel_missing')).toBeTruthy();
  });

  it('disables the picker and explains why when the node has no channels', () => {
    renderEditor([{ preset: null, region: 0, channelIndex: null }], []);
    const channelSelect = screen.getByLabelText('meshbeacon_config.target_channel') as HTMLSelectElement;
    expect(channelSelect.disabled).toBe(true);
    expect(screen.getByText('meshbeacon_config.targets_no_channels')).toBeTruthy();
  });
});

describe('BroadcastTargetsEditor — nanopb max_count:4 (#5062)', () => {
  const fullList: BroadcastTarget[] = Array.from({ length: MESH_BEACON_MAX_TARGETS }, () => ({
    preset: null,
    region: 0,
    channelIndex: null,
  }));

  it('allows adding up to the fourth target', () => {
    const onChange = renderEditor(fullList.slice(0, MESH_BEACON_MAX_TARGETS - 1));
    const addButton = screen.getByText('meshbeacon_config.target_add') as HTMLButtonElement;
    expect(addButton.disabled).toBe(false);
    fireEvent.click(addButton);
    expect(onChange.mock.calls[0][0]).toHaveLength(MESH_BEACON_MAX_TARGETS);
  });

  it('blocks a fifth target and says why — a longer list is dropped silently', () => {
    const onChange = renderEditor(fullList);
    const addButton = screen.getByText('meshbeacon_config.target_add') as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    expect(screen.getByText('meshbeacon_config.targets_max_reached')).toBeTruthy();

    fireEvent.click(addButton);
    expect(onChange).not.toHaveBeenCalled();
  });
});
